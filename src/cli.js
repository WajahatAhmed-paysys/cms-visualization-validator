#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { http } = require('./lib/http');
const auth = require('./core/auth');
const { runValidation, createContext, authenticate } = require('./core/executor');
const { printRun, writeArtifacts, buildVerifyArtifact, toVerifyMarkdown } = require('./core/report');
const { runVerify } = require('./verify/verifier');
const { VIEWS, buildChecks, QUERY_LABELS } = require('./core/registry');
const { RAW_QUERY_CATALOGUE } = require('./queries/raw');
const rawQueries = require('./queries/raw');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function asList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function usage() {
  console.log(`CMS Visualization Data Validator (PactumJS)

Usage:
  node src/cli.js validate --alert <id> [options]
  node src/cli.js verify --alert <id> [options]
  node src/cli.js registry
  node src/cli.js health
  node src/cli.js tables
  node src/cli.js login
  node src/cli.js query --sql "SELECT 1 AS n" --limit 1

Validate options:
  --alert <id>            Alert id (required)
  --tenant <id>           Tenant (default ${config.tenantId})
  --granularity <g>       day|month|year (default ${config.granularity})
  --roles <list>          creditor,debtor (default ${config.roles.join(',')})
  --mode <mode>           cms|raw|both (default cms)
  --e2e <id>              Pin the end-to-end id (skips derivation)
  --from <date>           Window start for history/benford (YYYY-MM-DD)
  --to <date>             Window end
  --time-range <r>        Transaction Network timeRange (default ${config.timeRange})
  --concurrency <n>       Parallel checks, 1-8 (default ${config.concurrency})
  --retry                 Retry a failed query once (transient 5xx/timeout)
  --json <path>           Custom JSON artifact path
  --md <path>             Custom Markdown artifact path
  --store-full            Include full SQL and response bodies in artifacts
  --verbose               Print per-query rows in the console
  --no-color              Disable ANSI colour
  --dry-run               Validate the registry/plan without any network call

Verify options:
  --alert <id>            Alert id (required)
  --tenant, --granularity, --roles, --concurrency, --e2e   (same meaning as validate)
  --tolerance <n>         Numeric tolerance for money/percent (default ${config.verifyTolerance})
  --json <path> / --md <path>   Custom artifact paths
  --verbose               Print every field result
  --dry-run               Show the verify plan without any network call

Examples:
  node src/cli.js validate --alert 12345
  node src/cli.js validate --alert 12345 --mode both --verbose
  node src/cli.js validate --alert 12345 --dry-run
`);
}

async function commandValidate(args) {
  const alertId = args.alert || args._[1];
  const dryRun = Boolean(args['dry-run']);

  const options = {
    alertId: dryRun && !alertId ? 1 : alertId,
    tenantId: args.tenant,
    granularity: args.granularity,
    roles: args.roles ? asList(args.roles) : undefined,
    mode: args.mode,
    e2eId: args.e2e,
    fromDate: args.from,
    toDate: args.to,
    timeRange: args['time-range'],
    concurrency: args.concurrency ? Number(args.concurrency) : undefined,
    retryTransient: Boolean(args.retry)
  };

  if (!options.alertId) {
    usage();
    process.exitCode = 2;
    return;
  }

  if (dryRun) {
    runDryRun(options);
    return;
  }

  const result = await runValidation(options);
  printRun(result, { verbose: Boolean(args.verbose), color: args['no-color'] ? false : undefined });

  const written = writeArtifacts(result, {
    jsonPath: args.json,
    mdPath: args.md,
    storeFullResponses: Boolean(args['store-full'])
  });
  console.log(`Artifacts written:\n  ${written.jsonPath}\n  ${written.mdPath}`);

  if (!result.bootstrap.ok) process.exitCode = 2;
  else if (result.summary.failed > 0) process.exitCode = 1;
  else process.exitCode = 0;
}

function runDryRun(options) {
  const checks = buildChecks(options.roles && options.roles.length ? options.roles : config.roles);
  const statements = RAW_QUERY_CATALOGUE.reduce((total, entry) => total + (entry.statements || 1), 0);

  console.log('DRY RUN - no network calls will be made');
  console.log('');
  console.log(`CMS base URL        : ${config.cmsBaseUrl}`);
  console.log(`Lakehouse base URL  : ${config.lakehouseBaseUrl}`);
  console.log(`Alert id            : ${options.alertId}${options.alertId === 1 ? ' (placeholder)' : ''}`);
  console.log(`Tenant              : ${options.tenantId || config.tenantId}`);
  console.log(`Granularity         : ${options.granularity || config.granularity}`);
  console.log(`Mode                : ${options.mode || 'cms'}`);
  console.log(`Roles               : ${(options.roles && options.roles.length ? options.roles : config.roles).join(', ')}`);
  console.log('');
  console.log(`Data views          : ${VIEWS.length}`);
  console.log(`Role-view checks    : ${checks.length}`);
  console.log(`Query labels        : ${RAW_QUERY_CATALOGUE.length}`);
  console.log(`SQL statements      : ${statements}`);
  console.log('');
  console.log('Planned checks:');
  for (const check of checks) {
    console.log(`  - ${check.card} / ${check.viewLabel}${check.role ? ` [${check.role}]` : ''}`);
  }
  console.log('');

  // Verify the raw SQL builders interpolate without throwing.
  const fake = {
    config,
    alertId: 12345,
    tenantId: 'DEFAULT',
    granularity: 'month',
    e2eId: 'e2e-placeholder',
    referenceId: 'reference-placeholder',
    fromDate: '2020-01-01',
    toDate: '2020-03-31'
  };
  const probes = [
    ['Q-NAV', () => rawQueries.qNav(fake)],
    ['Q-TD', () => rawQueries.qTd(fake)],
    ['Q-EM', () => rawQueries.qEm(fake)],
    ['Q-PROF-C', () => rawQueries.qProf('creditor', fake)],
    ['Q-A1', () => rawQueries.qA1(fake, 'entity-1')],
    ['Q-A2', () => rawQueries.qA2(fake, 'entity-1', ['acct-1', 'acct-2'])],
    ['Q-CP1', () => rawQueries.qCp1(fake, 'cp-1')],
    ['Q-CP2', () => rawQueries.qCp2(fake, ['cp-1', 'cp-2'])],
    ['Q-CP3', () => rawQueries.qCp3(fake, 'cp-1')],
    ['Q-CP4', () => rawQueries.qCp4(fake, 'cp-1')],
    ['Q-TN1', () => rawQueries.qTn1(fake, 'acct-1')],
    ['Q-TN2', () => rawQueries.qTn2(fake, 'acct-1', fake.fromDate, fake.toDate)],
    ['Q-TN3', () => rawQueries.qTn3(fake, 'acct-1', fake.fromDate, fake.toDate)],
    ['Q-TN4', () => rawQueries.qTn4(fake, 'acct-1', fake.fromDate, fake.toDate)],
    ['Q-TN5', () => rawQueries.qTn5(fake, ['acct-1', 'acct-2'])],
    ['Q-TN6', () => rawQueries.qTn6(fake, ['acct-1', 'acct-2'])],
    ['Q-AH1', () => rawQueries.qAh1(fake, 'entity-1')],
    ['Q-AH2', () => rawQueries.qAh2(fake, 'entity-1')],
    ['Q-AH3.count', () => rawQueries.qAh3Count(fake, 'entity-1')],
    ['Q-AH3.page', () => rawQueries.qAh3Page(fake, 'entity-1')],
    ['Q-TH1', () => rawQueries.qTh1(fake, 'acct-1')],
    ['Q-TH2', () => rawQueries.qTh2(fake, 'acct-1')],
    ['Q-TH3', () => rawQueries.qTh3(fake, 'acct-1')],
    ['Q-BF', () => rawQueries.qBf(fake, 'acct-1', fake.fromDate, fake.toDate)],
    ['Q-C1', () => rawQueries.qC1(fake)],
    ['Q-C2a', () => rawQueries.qC2a(fake, 'entity-1')],
    ['Q-C2b', () => rawQueries.qC2b(fake, 'acct-1')],
    ['Q-C3', () => rawQueries.qC3(fake, 'acct-1')],
    ['Q-C4', () => rawQueries.qC4(fake, 'entity-1')]
  ];
  let built = 0;
  for (const [name, probe] of probes) {
    try {
      const definition = probe();
      if (!definition || !(definition.sql || definition.tableQuery)) {
        throw new Error('builder returned no statement');
      }
      built += 1;
    } catch (error) {
      console.error(`  ! ${name} builder failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`SQL builders verified: ${built}/${probes.length}`);
  console.log('');
  console.log('Dry run complete. Nothing was executed.');
}

function commandRegistry() {
  const checks = buildChecks(config.roles);
  const statements = RAW_QUERY_CATALOGUE.reduce((total, entry) => total + (entry.statements || 1), 0);
  console.log('Query catalogue');
  console.log('');
  console.log(
    `Labels: ${RAW_QUERY_CATALOGUE.length}   Statements: ${statements}   Views: ${VIEWS.length}   Checks(default roles): ${checks.length}`
  );
  console.log('');
  console.log('| Id | View | Kind | Statements | Label |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const entry of RAW_QUERY_CATALOGUE) {
    console.log(
      `| ${entry.id} | ${entry.view} | ${entry.kind} | ${entry.statements || 1} | ${QUERY_LABELS[entry.id] || entry.label} |`
    );
  }
  console.log('');
  console.log('Views / role checks:');
  for (const view of VIEWS) {
    const roles = view.roles.map((role) => role || 'single').join(', ');
    console.log(`  - ${view.card} / ${view.label} [${roles}] -> ${view.queries.join(', ')}`);
  }
}

async function commandLogin() {
  const ctx = createContext({ alertId: 1, mode: 'cms' });
  await authenticate(ctx);
  console.log('Login successful.');
  console.log('Token:', JSON.stringify(ctx.tokenDescription));
  try {
    const me = await auth.me(ctx);
    console.log('GET /v1/auth/me:', JSON.stringify(me));
  } catch (error) {
    console.log('GET /v1/auth/me failed:', error.message);
  }
}

async function commandHealth() {
  const ctx = createContext({ alertId: 1, mode: 'cms' });
  await authenticate(ctx);
  const headers = { Authorization: `Bearer ${ctx.token}` };

  const health = await http({ method: 'GET', url: `${config.lakehouseBaseUrl}/health`, headers });
  console.log(
    'Lakehouse /health:',
    health.ok ? 'ok' : `FAILED (${health.statusCode || (health.error && health.error.code)})`,
    health.body ? JSON.stringify(health.body) : ''
  );

  const tables = await http({ method: 'GET', url: `${config.lakehouseBaseUrl}/tables`, headers });
  if (!tables.ok) {
    console.log('Lakehouse /tables: FAILED', tables.statusCode || (tables.error && tables.error.code));
    process.exitCode = 2;
    return;
  }
  const list = extractTableNames(tables.body);
  console.log(`Lakehouse /tables: ${list.length} table(s)`);
  const missing = config.expectedTables.filter((table) => !list.includes(table));
  console.log(`Expected tables present: ${config.expectedTables.length - missing.length}/${config.expectedTables.length}`);
  if (missing.length) console.log('Missing:', missing.join(', '));
}

function extractTableNames(body) {
  const normalise = (entry) => (typeof entry === 'string' ? entry : entry.name || entry.table_name);
  if (Array.isArray(body)) return body.map(normalise);
  if (body && Array.isArray(body.available_tables)) return body.available_tables.map(normalise);
  if (body && Array.isArray(body.tables)) return body.tables.map(normalise);
  if (body && Array.isArray(body.data)) return body.data.map(normalise);
  return [];
}

async function commandTables() {
  const ctx = createContext({ alertId: 1, mode: 'cms' });
  await authenticate(ctx);
  const tables = await http({
    method: 'GET',
    url: `${config.lakehouseBaseUrl}/tables`,
    headers: { Authorization: `Bearer ${ctx.token}` }
  });
  if (!tables.ok) {
    console.log('GET /tables FAILED', tables.statusCode || (tables.error && tables.error.code));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(tables.body, null, 2));
}

/** Read-only ad-hoc query against the Lakehouse, for discovery/diagnostics. */
async function commandQuery(args) {
  const sqlText = args.sql;
  if (!sqlText) {
    console.log('Usage: node src/cli.js query --sql "SELECT ..." [--limit 10]');
    process.exitCode = 2;
    return;
  }
  const ctx = createContext({ alertId: 1, mode: 'cms' });
  await authenticate(ctx);
  const response = await http({
    method: 'POST',
    url: `${config.lakehouseBaseUrl}/execute_sql`,
    headers: { Authorization: `Bearer ${ctx.token}` },
    body: { sql_query: sqlText, limit: Number(args.limit || 10) }
  });
  if (!response.ok) {
    console.log('Query FAILED', response.statusCode || (response.error && response.error.code));
    if (response.body) console.log(JSON.stringify(response.body, null, 2));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(response.body, null, 2));
}

async function commandVerify(args) {
  const alertId = args.alert || args._[1];
  const dryRun = Boolean(args['dry-run']);
  if (!alertId) {
    usage();
    process.exitCode = 2;
    return;
  }

  const roles = args.roles ? asList(args.roles) : undefined;

  if (dryRun) {
    runVerifyDryRun({ alertId, roles, granularity: args.granularity });
    return;
  }

  const result = await runVerify({
    alertId,
    tenantId: args.tenant,
    granularity: args.granularity,
    roles,
    e2eId: args.e2e,
    concurrency: args.concurrency ? Number(args.concurrency) : undefined,
    verifyTolerance: args.tolerance ? Number(args.tolerance) : undefined
  });

  printVerify(result, { verbose: Boolean(args.verbose) });

  fs.mkdirSync(config.reportDir, { recursive: true });
  const base = path.join(config.reportDir, `verify-${result.runId.replace(/[:.]/g, '-')}`);
  const jsonPath = args.json || `${base}.json`;
  const mdPath = args.md || `${base}.md`;
  fs.writeFileSync(jsonPath, JSON.stringify(buildVerifyArtifact(result), null, 2), 'utf8');
  fs.writeFileSync(mdPath, toVerifyMarkdown(result), 'utf8');
  console.log(`Artifacts written:\n  ${jsonPath}\n  ${mdPath}`);

  if (result.summary.mismatch > 0) process.exitCode = 1;
  else if (!result.resolved.entityMetadataOk) process.exitCode = 2;
  else process.exitCode = 0;
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

function printVerify(result, options = {}) {
  const summary = result.summary;
  console.log('CMS Data Verify');
  console.log(
    `Alert ${result.input.alertId}  |  tenant ${result.input.tenantId}  |  e2e ${result.resolved.endToEndId || '(unresolved)'}  |  ` +
      `granularity ${result.input.granularity}  |  roles ${(result.input.roles || []).join(', ')}  |  ${(result.totalDurationMs / 1000).toFixed(1)}s`
  );
  console.log('');
  const header = `${pad('VIEW / ROLE', 34)}${pad('STATUS', 15)}${pad('FIELDS', 8)}FIRST FAILURE`;
  console.log(header);
  console.log('-'.repeat(Math.max(header.length, 80)));
  for (const view of result.results) {
    const fields = view.fields || [];
    const passed = fields.filter((f) => f.pass).length;
    const firstFail = fields.find((f) => !f.pass && f.required);
    let detail = '';
    if (view.status === 'MISMATCH' && firstFail) {
      detail = `${firstFail.key}: expected ${fmt(firstFail.expected)} actual ${fmt(firstFail.actual)}${
        firstFail.delta != null ? ` Δ${firstFail.delta}` : ''
      }`;
    } else if (view.status !== 'VERIFIED') {
      detail = view.reason || '';
    }
    const label = `${view.viewLabel}${view.role ? ` [${view.role}]` : ''}`;
    console.log(`${pad(label, 34)}${pad(view.status, 15)}${pad(fields.length ? `${passed}/${fields.length}` : '-', 8)}${detail}`);

    if (options.verbose) {
      for (const f of fields) {
        console.log(
          `    ${f.pass ? 'PASS' : 'FAIL'} ${f.key} [${f.kind}] expected=${fmt(f.expected)} actual=${fmt(f.actual)}${
            f.informational ? ' (informational)' : ''
          }`
        );
      }
    }
  }
  console.log('');
  console.log(
    `Summary: ${summary.verified} verified, ${summary.mismatch} mismatch, ${summary.notComparable} not comparable, ` +
      `${summary.blocked} blocked (of ${summary.total}) · fields ${summary.fieldsPassed} passed / ${summary.fieldsFailed} failed`
  );
}

function fmt(value) {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function runVerifyDryRun({ alertId, roles, granularity }) {
  const activeRoles = roles && roles.length ? roles : config.roles;
  const checks = buildChecks(activeRoles);
  const { getContracts } = require('./verify/contracts');

  console.log('DATA VERIFY - dry run (no network calls)');
  console.log('');
  console.log(`Alert ${alertId}  |  granularity ${granularity || config.granularity}  |  roles ${activeRoles.join(', ')}`);
  console.log(`Views: 9  |  role-view checks: ${checks.length}`);
  console.log('');
  console.log('Planned checks:');
  for (const check of checks) {
    console.log(`  - ${check.card} / ${check.viewLabel}${check.role ? ` [${check.role}]` : ''}`);
  }
  console.log('');
  console.log('Contract coverage:');
  const viewKeys = [
    'alert-navigator',
    'transaction-details',
    'transaction-history',
    'network-transaction',
    'network-account',
    'network-counterparty',
    'alert-history',
    'conditions',
    'profile-overview'
  ];
  for (const viewKey of viewKeys) {
    console.log(`  - ${viewKey}: ${getContracts(viewKey) ? 'contract defined' : 'MISSING'}`);
  }
  console.log('');
  console.log('Dry run complete. Nothing was executed.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  try {
    switch (command) {
      case 'validate':
        await commandValidate(args);
        break;
      case 'verify':
        await commandVerify(args);
        break;
      case 'registry':
        commandRegistry();
        break;
      case 'health':
        await commandHealth();
        break;
      case 'tables':
        await commandTables();
        break;
      case 'query':
        await commandQuery(args);
        break;
      case 'login':
        await commandLogin();
        break;
      default:
        usage();
        process.exitCode = command ? 2 : 0;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    process.exitCode = 2;
  }
}

main();
