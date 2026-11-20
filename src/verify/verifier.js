'use strict';

const {
  createContext,
  authenticate,
  bootstrap,
  dispatchRaw,
  dispatchCms,
  blockedReasonFor,
  once
} = require('../core/executor');
const { buildChecks, getView } = require('../core/registry');
const { rowsOf, parseArray } = require('../core/status');
const { getContracts } = require('./contracts');
const { compareField } = require('./compare');
const { pool } = require('../lib/pool');
const sql = require('../lib/sql');
const cms = require('../queries/cms');
const rawExec = require('../core/raw-executor');
const log = require('../lib/logger');

// ---------------------------------------------------------------------------
// Bags
// ---------------------------------------------------------------------------

function buildRawBag(calls) {
  const rows = {};
  for (const call of calls || []) {
    if (!call) continue;
    const data = rowsOf(call.body);
    if (!rows[call.id]) rows[call.id] = [];
    rows[call.id] = rows[call.id].concat(data);
    if (call.subId) {
      if (!rows[call.subId]) rows[call.subId] = [];
      rows[call.subId] = rows[call.subId].concat(data);
    }
  }
  return { rows, calls: calls || [] };
}

function buildCmsBag(calls) {
  const bag = {};
  for (const call of calls || []) {
    if (!call) continue;
    if (!(call.id in bag) || !bag[call.id]) bag[call.id] = call.body;
  }
  return bag;
}

// ---------------------------------------------------------------------------
// Field evaluation
// ---------------------------------------------------------------------------

function safe(fn) {
  try {
    return { value: fn(), error: null };
  } catch (error) {
    return { value: undefined, error: error.message };
  }
}

function evaluateFields(contract, rawBag, cmsBag, meta) {
  const fields = contract ? contract(rawBag, cmsBag, meta) : [];
  return fields.map((f) => {
    const expected = safe(() => f.expected(rawBag, cmsBag, meta));
    const actual = safe(() => f.actual(rawBag, cmsBag, meta));
    const rawInput = f.input ? safe(() => f.input(rawBag, cmsBag, meta)) : expected;
    const comparison = compareField(f, expected.value, actual.value);
    // Show a numeric delta even for informational/optional fields, when both sides are numeric.
    let delta = comparison.delta;
    if (delta == null && expected.value != null && actual.value != null) {
      const e = Number(expected.value);
      const a = Number(actual.value);
      if (Number.isFinite(e) && Number.isFinite(a)) delta = Math.abs(e - a);
    }
    return {
      key: f.key,
      kind: f.kind,
      required: f.required !== false && f.kind !== 'informational',
      input: rawInput.value === undefined ? (rawInput.error ? `(error: ${rawInput.error})` : null) : rawInput.value,
      expected: expected.value === undefined ? (expected.error ? `(error: ${expected.error})` : null) : expected.value,
      actual: actual.value === undefined ? (actual.error ? `(error: ${actual.error})` : null) : actual.value,
      delta,
      pass: comparison.pass,
      informational: Boolean(comparison.informational),
      reason: comparison.reason || null
    };
  });
}

function aggregateStatus(fields) {
  const requiredFailures = fields.filter((f) => f.required && !f.pass);
  return requiredFailures.length > 0 ? 'MISMATCH' : 'VERIFIED';
}

// ---------------------------------------------------------------------------
// Time-pin helper for Alert History (spec §14.1)
// ---------------------------------------------------------------------------

async function runPair(ctx, check, shared) {
  // Per-check context clone so any view-specific fields cannot race with other
  // checks running in parallel.
  const local = Object.create(ctx);

  if (check.view === 'alert-history') {
    // Determinism (spec §14.1): pin ONE `now`, use it in both the raw date filter
    // and (implicitly) the CMS request, and require both to land in the same
    // period start. If a boundary is crossed, retry both together.
    let last = { rawCalls: [], cmsCalls: [] };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      local.now = new Date();
      const boundary = sql.periodStart(local.granularity, local.now);
      const rawCalls = await dispatchRaw(local, check.view, check.role, shared.raw);
      const cmsCalls = await dispatchCms(local, check.view, check.role, shared.cms);
      last = { rawCalls: rawCalls || [], cmsCalls: cmsCalls || [] };
      if (boundary === sql.periodStart(local.granularity, new Date())) return last;
      log.warn(`Alert History period boundary crossed (attempt ${attempt + 1}); retrying both sides.`);
    }
    return last;
  }

  const rawCalls = await dispatchRaw(local, check.view, check.role, shared.raw);
  const cmsCalls = await dispatchCms(local, check.view, check.role, shared.cms);
  return { rawCalls: rawCalls || [], cmsCalls: cmsCalls || [] };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function runVerify(options = {}) {
  const ctx = createContext({ ...options, mode: 'verify' });
  const startedAt = new Date();
  const startedMs = Date.now();

  await authenticate(ctx);
  await bootstrap(ctx);

  const checks = buildChecks(ctx.roles);
  const shared = {
    raw: { profile: once(() => rawExec.rawProfile(ctx)) },
    cms: { profile: once(() => cms.profileGenerate(ctx)) }
  };

  const worker = async (check) => {
    const view = getView(check.view);
    const base = {
      view: check.view,
      viewLabel: check.viewLabel,
      card: check.card,
      role: check.role || null
    };

    const reason = blockedReasonFor(view, check.role, ctx);
    if (reason) {
      return { ...base, status: 'BLOCKED', reason, durationMs: 0, fields: [] };
    }

    const started = Date.now();
    let rawCalls = [];
    let cmsCalls = [];
    try {
      const pair = await runPair(ctx, check, shared);
      rawCalls = pair.rawCalls;
      cmsCalls = pair.cmsCalls;
    } catch (error) {
      return { ...base, status: 'NOT_COMPARABLE', reason: `dispatch error: ${error.message}`, durationMs: Date.now() - started, fields: [] };
    }
    const durationMs = Date.now() - started;

    const cmsOk = cmsCalls.some((call) => call && call.ok);
    const rawOk = rawCalls.some((call) => call && call.ok);

    if (!cmsOk) {
      return { ...base, status: 'NOT_COMPARABLE', reason: 'CMS endpoint did not return data', durationMs, fields: [] };
    }
    if (!rawOk) {
      return { ...base, status: 'NOT_COMPARABLE', reason: 'raw Lakehouse data unavailable (no oracle)', durationMs, fields: [] };
    }

    const rawBag = buildRawBag(rawCalls);
    const cmsBag = buildCmsBag(cmsCalls);
    const contract = getContracts(check.view);
    const [defaultFrom, defaultTo] = sql.lastNDays(90);
    const meta = {
      role: check.role,
      granularity: ctx.granularity,
      fromDate: ctx.fromDate || defaultFrom,
      toDate: ctx.toDate || defaultTo
    };
    const fields = evaluateFields(contract, rawBag, cmsBag, meta);

    return { ...base, status: aggregateStatus(fields), reason: null, durationMs, fields };
  };

  const results = await pool(checks, worker, ctx.concurrency);
  const finishedAt = new Date();

  return {
    runId: `${startedAt.toISOString()}-${Math.random().toString(16).slice(2, 6)}`,
    mode: 'verify',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalDurationMs: Date.now() - startedMs,
    input: {
      alertId: ctx.alertId,
      tenantId: ctx.tenantId,
      roles: ctx.roles,
      granularity: ctx.granularity,
      tolerance: ctx.verifyTolerance
    },
    resolved: {
      endToEndId: ctx.e2eId || null,
      creditorId: ctx.ids.creditorId,
      debtorId: ctx.ids.debtorId,
      creditorAccountId: ctx.ids.creditorAccountId,
      debtorAccountId: ctx.ids.debtorAccountId,
      entityMetadataOk: ctx.entityMetadataOk
    },
    results,
    summary: summariseVerify(results),
    cards: groupCards(results)
  };
}

function summariseVerify(results) {
  const summary = { verified: 0, mismatch: 0, notComparable: 0, blocked: 0, total: results.length, fieldsPassed: 0, fieldsFailed: 0 };
  for (const result of results) {
    if (result.status === 'VERIFIED') summary.verified += 1;
    else if (result.status === 'MISMATCH') summary.mismatch += 1;
    else if (result.status === 'NOT_COMPARABLE') summary.notComparable += 1;
    else if (result.status === 'BLOCKED') summary.blocked += 1;
    for (const f of result.fields || []) {
      if (f.pass) summary.fieldsPassed += 1;
      else summary.fieldsFailed += 1;
    }
  }
  return summary;
}

const STATUS_SEVERITY = { VERIFIED: 2, MISMATCH: 4, NOT_COMPARABLE: 3, BLOCKED: 1, SKIPPED: 0 };

function groupCards(results) {
  const cards = new Map();
  for (const result of results) {
    if (!cards.has(result.card)) cards.set(result.card, { card: result.card, rows: [], status: 'SKIPPED', verified: 0, total: 0 });
    const card = cards.get(result.card);
    card.rows.push(result);
    card.total += 1;
    if (result.status === 'VERIFIED') card.verified += 1;
    if ((STATUS_SEVERITY[result.status] || 0) > (STATUS_SEVERITY[card.status] || 0)) card.status = result.status;
  }
  return Array.from(cards.values());
}

module.exports = { runVerify, summariseVerify, groupCards, buildRawBag, buildCmsBag, evaluateFields, aggregateStatus };
