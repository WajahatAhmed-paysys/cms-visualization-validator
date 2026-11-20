'use strict';

const config = require('../config');
const auth = require('./auth');
const cms = require('../queries/cms');
const raw = require('./raw-executor');
const { buildChecks, getView } = require('./registry');
const { evaluateCheck, aggregateCards, summarise } = require('./status');
const { pool } = require('../lib/pool');
const log = require('../lib/logger');

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

function createContext(options = {}) {
  const alertId = Number(options.alertId);
  if (!Number.isFinite(alertId) || alertId <= 0) {
    throw new Error(`A numeric alert id is required (received: ${options.alertId})`);
  }

  return {
    config,
    alertId,
    tenantId: options.tenantId || config.tenantId,
    granularity: options.granularity || config.granularity,
    roles: options.roles && options.roles.length ? options.roles : config.roles,
    mode: options.mode || 'cms',
    requestTimeoutMs: Number(options.requestTimeoutMs) > 0 ? Number(options.requestTimeoutMs) : config.requestTimeoutMs,
    concurrency: Number(options.concurrency) > 0 ? Number(options.concurrency) : config.concurrency,
    retryTransient: options.retryTransient !== undefined ? Boolean(options.retryTransient) : false,
    e2eId: options.e2eId || config.e2eId || '',
    fromDate: options.fromDate || config.fromDate,
    toDate: options.toDate || config.toDate,
    timeRange: options.timeRange || config.timeRange,
    token: null,
    reauth: null,
    ids: {},
    bootstrap: null,
    entityMetadataOk: false
  };
}

async function authenticate(ctx) {
  const result = await auth.login(ctx);
  ctx.token = result.token;
  ctx.tokenDescription = result.description;
  ctx.reauth = async () => {
    const refreshed = await auth.login(ctx);
    ctx.token = refreshed.token;
    ctx.tokenDescription = refreshed.description;
  };
}

function deriveE2e(navCall) {
  if (!navCall || !navCall.ok || !navCall.body) return null;
  const body = navCall.body;
  const txId = (body.alertMetadata && body.alertMetadata.transactionId) || body.transactionId;
  if (!txId) return null;
  const text = String(txId);
  const parts = text.split('||');
  return parts.length > 1 ? parts[parts.length - 1] : text;
}

async function bootstrap(ctx) {
  const meCall = await cms.authMe(ctx).catch(() => null);
  if (meCall && meCall.ok && meCall.body && meCall.body.tenantId) {
    ctx.tenantId = meCall.body.tenantId;
  }

  const [navCall, emCall] = await Promise.all([cms.alertNavigator(ctx), cms.entityMetadata(ctx)]);
  ctx.bootstrap = { navCall, emCall, meCall };
  ctx.e2eId = ctx.e2eId || deriveE2e(navCall) || '';

  const em = emCall && emCall.ok ? emCall.body || {} : {};
  ctx.ids = {
    creditorId: em.creditorId || null,
    debtorId: em.debtorId || null,
    creditorAccountId: em.creditorAccountId || null,
    debtorAccountId: em.debtorAccountId || null,
    creditorName: em.creditorName || null,
    debtorName: em.debtorName || null
  };
  ctx.entityMetadataOk = Boolean(emCall && emCall.ok);
  return ctx.bootstrap;
}

function blockedReasonFor(view, role, ctx) {
  if (!view) return null;
  if (view.roleScope === 'account') {
    const field = role === 'creditor' ? 'creditorAccountId' : 'debtorAccountId';
    return ctx.ids[field] ? null : `${field} is null in entity metadata`;
  }
  if (view.roleScope === 'entity') {
    const field = role === 'creditor' ? 'creditorId' : 'debtorId';
    return ctx.ids[field] ? null : `${field} is null in entity metadata`;
  }
  if (view.key === 'transaction-details' || view.key === 'conditions') {
    return ctx.e2eId ? null : 'endToEndId could not be resolved from Alert Navigator';
  }
  return null;
}

function once(fn) {
  let promise;
  return (...args) => {
    if (!promise) promise = fn(...args);
    return promise;
  };
}

// ---------------------------------------------------------------------------
// CMS-mode dispatch
// ---------------------------------------------------------------------------

async function dispatchCms(ctx, viewKey, role, shared) {
  switch (viewKey) {
    case 'alert-navigator':
      return [ctx.bootstrap.navCall];
    case 'transaction-details': {
      const call = await cms.transactionDetails(ctx);
      return call ? [call] : [];
    }
    case 'profile-overview':
      return [await shared.profile()];
    case 'network-transaction':
      return [await cms.transactionNetwork(ctx, role, ctx.ids[`${role}AccountId`])];
    case 'network-account':
      return [await cms.accountNetwork(ctx, role, ctx.ids[`${role}Id`])];
    case 'network-counterparty':
      return [await cms.counterpartyNetwork(ctx, role, ctx.ids[`${role}Id`])];
    case 'alert-history':
      return cms.alertHistory(ctx, role, ctx.ids[`${role}Id`]);
    case 'transaction-history':
      return cms.transactionHistory(ctx, role, ctx.ids[`${role}AccountId`]);
    case 'conditions':
      return cms.conditions(ctx);
    default:
      throw new Error(`No CMS dispatcher for view ${viewKey}`);
  }
}

async function runCmsChecks(ctx, checks) {
  const shared = { profile: once(() => cms.profileGenerate(ctx)) };

  const worker = async (check) => {
    const view = getView(check.view);
    const reason = blockedReasonFor(view, check.role, ctx);
    if (reason) {
      check.blockedReason = reason;
      return evaluateCheck(check, []);
    }

    const startedAt = Date.now();
    let calls = [];
    try {
      calls = await dispatchCms(ctx, check.view, check.role, shared);
    } catch (error) {
      log.debug(`CMS dispatch error for ${check.view}: ${error.message}`);
      calls = [
        {
          id: check.view,
          label: check.viewLabel,
          mode: 'cms',
          ok: false,
          statusCode: null,
          durationMs: Date.now() - startedAt,
          body: null,
          error: { code: 'UNEXPECTED', message: error.message }
        }
      ];
    }
    check.durationMs = Date.now() - startedAt;
    return evaluateCheck(check, calls.filter(Boolean));
  };

  return pool(checks, worker, ctx.concurrency);
}

// ---------------------------------------------------------------------------
// Raw-mode dispatch
// ---------------------------------------------------------------------------

async function dispatchRaw(ctx, viewKey, role, shared) {
  switch (viewKey) {
    case 'alert-navigator':
      return raw.rawAlertNavigator(ctx);
    case 'transaction-details':
      return raw.rawTransactionDetails(ctx);
    case 'profile-overview':
      return shared.profile();
    case 'network-transaction':
      return raw.rawTransactionNetwork(ctx, role);
    case 'network-account':
      return raw.rawAccountNetwork(ctx, role);
    case 'network-counterparty':
      return raw.rawCounterpartyNetwork(ctx, role);
    case 'alert-history':
      return raw.rawAlertHistory(ctx, role);
    case 'transaction-history':
      return raw.rawTransactionHistory(ctx, role);
    case 'conditions':
      return raw.rawConditions(ctx);
    default:
      throw new Error(`No raw dispatcher for view ${viewKey}`);
  }
}

async function runRawChecks(ctx, checks) {
  const shared = { profile: once(() => raw.rawProfile(ctx)) };

  const worker = async (check) => {
    const view = getView(check.view);
    const reason = blockedReasonFor(view, check.role, ctx);
    if (reason) {
      check.blockedReason = reason;
      return evaluateCheck(check, []);
    }

    const startedAt = Date.now();
    let calls = [];
    try {
      calls = await dispatchRaw(ctx, check.view, check.role, shared);
    } catch (error) {
      calls = [
        {
          id: check.view,
          label: check.viewLabel,
          mode: 'raw',
          ok: false,
          statusCode: null,
          durationMs: Date.now() - startedAt,
          error: { code: 'UNEXPECTED', message: error.message }
        }
      ];
    }
    check.durationMs = Date.now() - startedAt;
    return evaluateCheck(check, calls.filter(Boolean));
  };

  return pool(checks, worker, ctx.concurrency);
}

/** In "both" mode, attach raw per-query drill-down to the CMS-evaluated results. */
async function attachRaw(ctx, results) {
  const shared = { profile: once(() => raw.rawProfile(ctx)) };

  const worker = async (result) => {
    const view = getView(result.view);
    const reason = blockedReasonFor(view, result.role, ctx);
    if (reason) {
      result.rawQueries = [];
      return;
    }
    try {
      result.rawQueries = await dispatchRaw(ctx, result.view, result.role, shared);
    } catch (error) {
      result.rawQueries = [];
    }
  };

  await pool(results, (result) => worker(result), ctx.concurrency);
  return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function runValidation(options = {}) {
  const ctx = createContext(options);
  const startedAt = new Date();
  const startedMs = Date.now();

  await authenticate(ctx);
  await bootstrap(ctx);

  const checks = buildChecks(ctx.roles);
  let results;
  if (ctx.mode === 'raw') {
    results = await runRawChecks(ctx, checks);
  } else {
    results = await runCmsChecks(ctx, checks);
    if (ctx.mode === 'both') {
      await attachRaw(ctx, results);
    }
  }

  const cards = aggregateCards(results);
  const summary = summarise(results);
  const finishedAt = new Date();

  return {
    runId: `${startedAt.toISOString()}-${Math.random().toString(16).slice(2, 6)}`,
    mode: ctx.mode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalDurationMs: Date.now() - startedMs,
    input: {
      alertId: ctx.alertId,
      tenantId: ctx.tenantId,
      roles: ctx.roles,
      granularity: ctx.granularity,
      mode: ctx.mode
    },
    resolved: {
      endToEndId: ctx.e2eId || null,
      creditorId: ctx.ids.creditorId,
      debtorId: ctx.ids.debtorId,
      creditorAccountId: ctx.ids.creditorAccountId,
      debtorAccountId: ctx.ids.debtorAccountId,
      creditorName: ctx.ids.creditorName,
      debtorName: ctx.ids.debtorName,
      entityMetadataOk: ctx.entityMetadataOk
    },
    bootstrap: summariseBootstrap(ctx.bootstrap),
    cards,
    views: results,
    summary
  };
}

function summariseBootstrap(bootstrapCalls) {
  const result = { calls: [], ok: true, message: null };
  if (!bootstrapCalls) return result;
  for (const [name, call] of Object.entries(bootstrapCalls)) {
    if (!call) continue;
    result.calls.push({
      name,
      id: call.id,
      ok: call.ok,
      statusCode: call.statusCode,
      durationMs: call.durationMs
    });
    if (!call.ok) {
      result.ok = false;
      result.message = `${call.id}: ${call.statusCode || 'network error'}`;
    }
  }
  return result;
}

module.exports = {
  runValidation,
  createContext,
  bootstrap,
  authenticate,
  deriveE2e,
  dispatchRaw,
  dispatchCms,
  blockedReasonFor,
  once
};
