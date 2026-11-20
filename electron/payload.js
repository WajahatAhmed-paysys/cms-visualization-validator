'use strict';

const { redact, truncateResponse } = require('../src/lib/redact');
const { VIEWS } = require('../src/core/registry');

/**
 * Convert a raw RunResult into a serialisable payload for the renderer.
 * Credentials/tokens are never present in RunResult; responses are truncated
 * and redacted defensively so the renderer never receives huge payloads.
 */

function sanitizeCall(call) {
  const rawSql = call.sql || (call.request && call.request.body && call.request.body.sql_query) || null;
  return {
    id: call.id,
    subId: call.subId || null,
    label: call.label || call.id,
    mode: call.mode || 'cms',
    ok: Boolean(call.ok),
    statusCode: call.statusCode != null ? call.statusCode : null,
    rowCount: call.rowCount != null ? call.rowCount : null,
    durationMs: call.durationMs || 0,
    attempts: call.attempts || 1,
    error: call.error || null,
    sql: rawSql ? String(rawSql).slice(0, 8000) : null,
    request: redact(call.request || null),
    response: truncateResponse(call.body, { maxRows: 50, maxBytes: 120000 })
  };
}

function sanitizeView(view) {
  return {
    view: view.view,
    viewLabel: view.viewLabel,
    card: view.card,
    role: view.role,
    status: view.status,
    reason: view.reason,
    durationMs: view.durationMs || 0,
    metrics: view.metrics || {},
    queries: (view.queries || []).map(sanitizeCall)
  };
}

function buildUiPayload(result) {
  const byCard = new Map();
  for (const view of result.views) {
    if (!byCard.has(view.card)) byCard.set(view.card, []);
    byCard.get(view.card).push(sanitizeView(view));
  }

  const cardOrder = [];
  for (const view of VIEWS) {
    if (!cardOrder.includes(view.card)) cardOrder.push(view.card);
  }

  const cards = [];
  for (const name of cardOrder) {
    const rows = byCard.get(name);
    if (!rows) continue;
    const aggregate = (result.cards || []).find((entry) => entry.card === name) || {};
    cards.push({
      card: name,
      status: aggregate.status || 'SKIPPED',
      available: aggregate.available || 0,
      total: aggregate.total || rows.length,
      rows
    });
  }

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
    cards
  };
}

function buildVerifyPayload(result) {
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

module.exports = { buildUiPayload, buildVerifyPayload, sanitizeCall, sanitizeView };
