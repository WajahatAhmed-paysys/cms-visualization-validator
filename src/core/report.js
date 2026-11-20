'use strict';

const fs = require('fs');
const path = require('path');
const { redact, truncateResponse } = require('../lib/redact');
const { VIEWS } = require('./registry');

const COLORS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m'
};

const STATUS_COLOR = {
  AVAILABLE: 'green',
  EMPTY: 'yellow',
  FAILED: 'red',
  BLOCKED: 'gray',
  SKIPPED: 'gray'
};

function colorize(enabled) {
  return (name, text) => (enabled ? `${COLORS[name] || ''}${text}${COLORS.reset}` : text);
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

function padStart(value, width) {
  return String(value).padStart(width, ' ');
}

function fmtMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function queryCount(check) {
  const count = Array.isArray(check.queries) ? check.queries.length : 0;
  if (!count) return '0';
  const failed = check.queries.filter((call) => call && !call.ok).length;
  return failed ? `${count - failed}/${count}` : `${count}`;
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

function printRun(result, options = {}) {
  const color = colorize(options.color !== false && process.stdout.isTTY !== false && !process.env.NO_COLOR);
  const out = options.out || console.log;
  const c = (name, text) => color(name, text);

  out('');
  out(c('bold', 'CMS Visualization Data Validator'));
  const resolved = result.resolved || {};
  out(
    `${c('cyan', 'Alert')} ${result.input.alertId}  |  tenant ${result.input.tenantId}  |  e2e ${
      resolved.endToEndId || '(unresolved)'
    }  |  mode ${result.mode}  |  granularity ${result.input.granularity}  |  roles ${result.input.roles.join(', ')}`
  );
  out(`${c('dim', 'Run')} ${result.runId}  |  ${fmtMs(result.totalDurationMs)}`);

  const boot = result.bootstrap || {};
  if (boot.ok) {
    out(
      `${c('green', 'BOOTSTRAP ok')}  ${(boot.calls || [])
        .map((call) => `${call.id} ${call.ok ? fmtMs(call.durationMs) : 'FAILED'}`)
        .join('  ')}`
    );
  } else {
    out(c('red', `BOOTSTRAP FAILED  ${boot.message || ''}`));
  }
  out('');

  const header = `${pad('CARD', 26)}${pad('ROLE', 10)}${pad('STATUS', 12)}${padStart('Q', 4)}  ${padStart('TIME', 7)}  DETAIL`;
  out(c('bold', header));
  out(c('dim', '-'.repeat(header.length)));

  let lastCard = null;
  for (const check of result.views) {
    const cardLabel = check.card === lastCard ? '' : check.card;
    lastCard = check.card;
    const statusName = STATUS_COLOR[check.status];
    const status = c(statusName, pad(check.status, 12));
    const line = `${pad(cardLabel, 26)}${pad(check.role || '-', 10)}${status}${padStart(queryCount(check), 4)}  ${padStart(
      fmtMs(check.durationMs),
      7
    )}  ${check.reason || ''}`;
    out(line);

    if (options.verbose && Array.isArray(check.queries) && check.queries.length) {
      for (const call of check.queries) {
        const ok = call.ok ? c('green', 'ok') : c('red', 'FAIL');
        out(
          c(
            'dim',
            `${' '.repeat(28)}- ${pad(call.id, 8)} ${pad(call.subId || '', 12)} ${ok}  HTTP ${call.statusCode || '-'}  rows ${
              call.rowCount != null ? call.rowCount : '-'
            }  ${fmtMs(call.durationMs)}${call.error ? `  (${call.error.message})` : ''}`
          )
        );
      }
    }
  }

  out('');
  const summary = result.summary;
  out(
    `${c('bold', 'Summary')}: ` +
      [
        c('green', `${summary.available} available`),
        c('yellow', `${summary.empty} empty`),
        c('red', `${summary.failed} failed`),
        c('gray', `${summary.blocked} blocked`)
      ].join(', ') +
      ` (${summary.total} checks)`
  );

  const slowest = slowestQuery(result);
  if (slowest) {
    out(`${c('dim', 'Slowest query')}: ${slowest.id} (${slowest.view}) ${fmtMs(slowest.durationMs)}`);
  }
  out('');
  return out;
}

function slowestQuery(result) {
  let slowest = null;
  for (const check of result.views) {
    for (const call of check.queries || []) {
      if (!slowest || (call.durationMs || 0) > (slowest.durationMs || 0)) {
        slowest = { ...call, view: check.viewLabel };
      }
    }
  }
  return slowest;
}

// ---------------------------------------------------------------------------
// JSON artifact
// ---------------------------------------------------------------------------

function buildArtifact(result, options = {}) {
  const storeFull = Boolean(options.storeFullResponses);
  return {
    runId: result.runId,
    mode: result.mode,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    totalDurationMs: result.totalDurationMs,
    input: result.input,
    resolved: result.resolved,
    bootstrap: result.bootstrap,
    summary: result.summary,
    cards: result.cards.map((card) => ({
      card: card.card,
      status: card.status,
      available: card.available,
      total: card.total
    })),
    views: result.views.map((check) => ({
      view: check.view,
      viewLabel: check.viewLabel,
      card: check.card,
      role: check.role,
      status: check.status,
      reason: check.reason,
      durationMs: check.durationMs,
      metrics: check.metrics,
      queries: (check.queries || []).map((call) => ({
        id: call.id,
        subId: call.subId || null,
        label: call.label,
        mode: call.mode,
        ok: call.ok,
        statusCode: call.statusCode,
        rowCount: call.rowCount != null ? call.rowCount : null,
        durationMs: call.durationMs,
        error: call.error || null,
        sql: storeFull ? call.sql : call.sql ? '[omitted - use --store-full]' : null,
        request: redact(call.request || null),
        response: storeFull ? redact(truncateResponse(call.body)) : undefined
      })),
      rawQueries: check.rawQueries
        ? check.rawQueries.map((call) => ({
            id: call.id,
            subId: call.subId || null,
            ok: call.ok,
            statusCode: call.statusCode,
            rowCount: call.rowCount,
            durationMs: call.durationMs,
            error: call.error || null
          }))
        : undefined
    }))
  };
}

function writeArtifacts(result, options = {}) {
  const dir = options.dir || require('../config').reportDir;
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `run-${result.runId.replace(/[:.]/g, '-')}`);

  const jsonPath = options.jsonPath || `${base}.json`;
  const mdPath = options.mdPath || `${base}.md`;

  const artifact = buildArtifact(result, options);
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2), 'utf8');
  fs.writeFileSync(mdPath, toMarkdown(result, options), 'utf8');

  return { jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function toMarkdown(result, options = {}) {
  const lines = [];
  const resolved = result.resolved || {};
  const summary = result.summary;

  lines.push('# CMS Visualization Data Availability Report');
  lines.push('');
  lines.push(`- **Run id:** ${result.runId}`);
  lines.push(`- **Generated:** ${result.finishedAt}`);
  lines.push(`- **Alert id:** ${result.input.alertId}`);
  lines.push(`- **Tenant:** ${result.input.tenantId}`);
  lines.push(`- **End-to-end id:** ${resolved.endToEndId || '(unresolved)'}`);
  lines.push(`- **Mode:** ${result.mode}  |  **Granularity:** ${result.input.granularity}  |  **Roles:** ${result.input.roles.join(', ')}`);
  lines.push(`- **Duration:** ${fmtMs(result.totalDurationMs)}`);
  lines.push('');
  lines.push(
    `**Summary:** ${summary.available} available, ${summary.empty} empty, ${summary.failed} failed, ${summary.blocked} blocked (of ${summary.total} checks).`
  );
  lines.push('');

  const boot = result.bootstrap || {};
  lines.push('## Bootstrap');
  lines.push(boot.ok ? '- Status: **ok**' : `- Status: **FAILED** - ${boot.message || ''}`);
  for (const call of boot.calls || []) {
    lines.push(`  - ${call.id}: ${call.ok ? 'ok' : 'FAILED'} (${fmtMs(call.durationMs)}, HTTP ${call.statusCode || '-'})`);
  }
  lines.push('');
  lines.push('Resolved identifiers:');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  for (const key of ['creditorId', 'debtorId', 'creditorAccountId', 'debtorAccountId', 'creditorName', 'debtorName']) {
    lines.push(`| ${key} | ${resolved[key] || '_(null)_'} |`);
  }
  lines.push('');

  const byCard = new Map();
  for (const check of result.views) {
    if (!byCard.has(check.card)) byCard.set(check.card, []);
    byCard.get(check.card).push(check);
  }

  lines.push('## Results');
  lines.push('');
  for (const view of VIEWS) {
    if (!byCard.has(view.card)) continue;
    const rows = byCard.get(view.card);
    const cardStatus = rows.map((row) => row.status);
    lines.push(`### ${view.card} (${rows.length === 1 && rows[0].role == null ? 'single check' : `${rows.length} checks`})`);
    lines.push('');
    lines.push('| View | Role | Status | Queries | Time | Detail |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      lines.push(
        `| ${row.viewLabel} | ${row.role || '-'} | **${row.status}** | ${queryCount(row)} | ${fmtMs(row.durationMs)} | ${
          row.reason || ''
        } |`
      );
    }
    lines.push('');
    if (cardStatus.length && cardStatus.every((status) => status === 'AVAILABLE')) {
      lines.push('_All checks available._');
      lines.push('');
    }
  }

  lines.push('## Per-query detail');
  lines.push('');
  for (const check of result.views) {
    if (!check.queries || !check.queries.length) continue;
    lines.push(`### ${check.viewLabel}${check.role ? ` - ${check.role}` : ''}`);
    lines.push('');
    lines.push('| Query | Label | Mode | HTTP | Rows | Time | Result |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const call of check.queries) {
      lines.push(
        `| ${call.id}${call.subId ? ` (${call.subId})` : ''} | ${call.label || ''} | ${call.mode} | ${call.statusCode || '-'} | ${
          call.rowCount != null ? call.rowCount : '-'
        } | ${fmtMs(call.durationMs)} | ${call.ok ? 'ok' : `FAIL: ${call.error ? call.error.message : 'HTTP ' + call.statusCode}`} |`
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_This report was produced by the read-only CMS Visualization Data Validator. No repository, database or case data was modified._');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Data Verify artifacts
// ---------------------------------------------------------------------------

function buildVerifyArtifact(result) {
  return {
    runId: result.runId,
    mode: 'verify',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    totalDurationMs: result.totalDurationMs,
    input: result.input,
    resolved: result.resolved,
    summary: result.summary,
    cards: (result.cards || []).map((card) => ({
      card: card.card,
      status: card.status,
      verified: card.verified,
      total: card.total
    })),
    results: (result.results || []).map((view) => ({
      view: view.view,
      viewLabel: view.viewLabel,
      card: view.card,
      role: view.role,
      status: view.status,
      reason: view.reason,
      durationMs: view.durationMs,
      fields: (view.fields || []).map((f) => ({
        key: f.key,
        kind: f.kind,
        required: f.required,
        input: f.input,
        expected: f.expected,
        actual: f.actual,
        delta: f.delta,
        pass: f.pass,
        informational: f.informational,
        reason: f.reason
      }))
    }))
  };
}

function toVerifyMarkdown(result) {
  const lines = [];
  const s = result.summary;
  const resolved = result.resolved || {};
  lines.push('# CMS Data Verify Report');
  lines.push('');
  lines.push(`- **Run id:** ${result.runId}`);
  lines.push(`- **Generated:** ${result.finishedAt}`);
  lines.push(`- **Alert id:** ${result.input.alertId}`);
  lines.push(`- **Tenant:** ${result.input.tenantId}`);
  lines.push(`- **End-to-end id:** ${resolved.endToEndId || '(unresolved)'}`);
  lines.push(`- **Granularity:** ${result.input.granularity}  |  **Roles:** ${(result.input.roles || []).join(', ')}`);
  lines.push(`- **Duration:** ${fmtMs(result.totalDurationMs)}`);
  lines.push('');
  lines.push(
    `**Summary:** ${s.verified} verified, ${s.mismatch} mismatch, ${s.notComparable} not comparable, ${s.blocked} blocked ` +
      `(of ${s.total}) · fields passed ${s.fieldsPassed}, failed ${s.fieldsFailed}.`
  );
  lines.push('');

  lines.push('## Results');
  lines.push('');
  lines.push('| View / Role | Status | Fields | Notes |');
  lines.push('| --- | --- | --- | --- |');
  for (const view of result.results || []) {
    const fields = view.fields || [];
    const passed = fields.filter((f) => f.pass).length;
    const label = `${view.viewLabel}${view.role ? ` [${view.role}]` : ''}`;
    lines.push(`| ${label} | **${view.status}** | ${fields.length ? `${passed}/${fields.length}` : '-'} | ${view.reason || ''} |`);
  }
  lines.push('');

  lines.push('## Field detail');
  lines.push('');
  for (const view of result.results || []) {
    if (!view.fields || !view.fields.length) continue;
    lines.push(`### ${view.viewLabel}${view.role ? ` - ${view.role}` : ''} (${view.status})`);
    lines.push('');
    lines.push('| Field | API data | After calculation | CMS value | Delta | Result |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const f of view.fields) {
      const resultText = f.informational ? 'INFO' : f.pass ? 'PASS' : 'FAIL';
      lines.push(
        `| ${f.key} | ${formatValue(f.input)} | ${formatValue(f.expected)} | ${formatValue(f.actual)} | ${
          f.delta != null ? f.delta : '-'
        } | ${resultText} |`
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_This report was produced by the read-only CMS Visualization Data Validator (Data Verify). No repository, database or case data was modified._');
  return lines.join('\n');
}

function formatValue(value) {
  if (value === null || value === undefined) return '_(empty)_';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toVerifyCsv(result) {
  const header = ['runId', 'alertId', 'view', 'role', 'field', 'kind', 'apiData', 'afterCalculation', 'cmsValue', 'delta', 'result'];
  const lines = [header.join(',')];
  for (const view of result.results || []) {
    for (const f of view.fields || []) {
      const resultText = f.informational ? 'INFO' : f.pass ? 'PASS' : 'FAIL';
      const row = [
        result.runId,
        result.input.alertId,
        view.view,
        view.role || '',
        f.key,
        f.kind,
        csvCell(f.input),
        csvCell(f.expected),
        csvCell(f.actual),
        f.delta != null ? f.delta : '',
        resultText
      ];
      lines.push(row.join(','));
    }
  }
  return lines.join('\n');
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

module.exports = {
  printRun,
  writeArtifacts,
  buildArtifact,
  toMarkdown,
  slowestQuery,
  fmtMs,
  buildVerifyArtifact,
  toVerifyMarkdown,
  toVerifyCsv
};
