'use strict';

/**
 * Capture one raw+CMS fixture per view/role so comparisons can be re-run offline.
 * One live pass only. Read-only. Writes tests/fixtures/verify-fixtures.json.
 *
 *   node scripts/capture-verify-fixtures.js 796
 */

const fs = require('fs');
const path = require('path');
const {
  createContext,
  authenticate,
  bootstrap,
  dispatchRaw,
  dispatchCms,
  blockedReasonFor,
  once
} = require('../src/core/executor');
const { buildChecks, getView } = require('../src/core/registry');
const { buildRawBag, buildCmsBag, evaluateFields, aggregateStatus } = require('../src/verify/verifier');
const { getContracts } = require('../src/verify/contracts');
const cms = require('../src/queries/cms');
const rawExec = require('../src/core/raw-executor');

function stripHudi(rows) {
  return (rows || []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const clean = {};
    for (const [key, value] of Object.entries(row)) {
      if (!key.startsWith('_hoodie_')) clean[key] = value;
    }
    return clean;
  });
}

(async () => {
  const alertId = Number(process.argv[2] || 796);
  const ctx = createContext({ alertId, mode: 'verify' });
  await authenticate(ctx);
  await bootstrap(ctx);

  const shared = {
    raw: { profile: once(() => rawExec.rawProfile(ctx)) },
    cms: { profile: once(() => cms.profileGenerate(ctx)) }
  };

  const checks = buildChecks(ctx.roles);
  const out = [];

  for (const check of checks) {
    const base = { view: check.view, viewLabel: check.viewLabel, card: check.card, role: check.role };
    const reason = blockedReasonFor(getView(check.view), check.role, ctx);
    if (reason) {
      out.push({ ...base, status: 'BLOCKED', reason, rawCalls: [], cmsCalls: [], fields: [] });
      console.log(`${check.view} ${check.role || ''} -> BLOCKED`);
      continue;
    }

    const local = Object.create(ctx);
    if (check.view === 'alert-history') local.now = new Date();

    const rawCalls = (await dispatchRaw(local, check.view, check.role, shared.raw)) || [];
    const cmsCalls = (await dispatchCms(local, check.view, check.role, shared.cms)) || [];

    const cmsOk = cmsCalls.some((call) => call && call.ok);
    const rawOk = rawCalls.some((call) => call && call.ok);

    let status = 'NOT_COMPARABLE';
    let fields = [];
    if (cmsOk && rawOk) {
      const rawBag = buildRawBag(rawCalls);
      const cmsBag = buildCmsBag(cmsCalls);
      fields = evaluateFields(getContracts(check.view), rawBag, cmsBag, { role: check.role, granularity: ctx.granularity });
      status = aggregateStatus(fields);
    }

    out.push({
      ...base,
      status,
      reason: status === 'NOT_COMPARABLE' ? (rawOk ? 'CMS endpoint did not return data' : 'raw unavailable') : null,
      rawCalls: rawCalls.map((call) => ({
        id: call.id,
        subId: call.subId || null,
        ok: call.ok,
        statusCode: call.statusCode,
        body: call.body && call.body.data ? { ...call.body, data: stripHudi(call.body.data) } : call.body
      })),
      cmsCalls: cmsCalls.map((call) => ({ id: call.id, subId: call.subId || null, ok: call.ok, statusCode: call.statusCode, body: call.body })),
      fields: fields.map((f) => ({
        key: f.key,
        kind: f.kind,
        required: f.required,
        expected: f.expected,
        actual: f.actual,
        delta: f.delta,
        pass: f.pass,
        informational: f.informational,
        reason: f.reason
      }))
    });
    console.log(`${check.view} ${check.role || ''} -> ${status}`);
  }

  const dir = path.join(__dirname, '..', 'tests', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'verify-fixtures.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        alertId,
        tenantId: ctx.tenantId,
        granularity: ctx.granularity,
        roles: ctx.roles,
        resolved: ctx.ids,
        checks: out
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\nFixtures written: ${out.length} checks -> tests/fixtures/verify-fixtures.json`);
})().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
