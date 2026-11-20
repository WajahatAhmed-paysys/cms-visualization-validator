'use strict';

/**
 * Offline regression test over captured fixtures. Asserts the comparison engine
 * reproduces the statuses recorded at capture time (no network). Skipped when
 * tests/fixtures/verify-fixtures.json is absent.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildRawBag, buildCmsBag, evaluateFields, aggregateStatus } = require('../../src/verify/verifier');
const { getContracts } = require('../../src/verify/contracts');

const file = path.join(__dirname, '..', 'fixtures', 'verify-fixtures.json');
const exists = fs.existsSync(file);
const describeOrSkip = exists ? describe : describe.skip;

describeOrSkip('verify fixtures (offline)', () => {
  const fixtures = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : { checks: [] };

  it('reproduces the captured status and per-field results deterministically', () => {
    for (const check of fixtures.checks) {
      if (check.status === 'BLOCKED' || check.status === 'NOT_COMPARABLE') continue;
      const rawBag = buildRawBag(check.rawCalls);
      const cmsBag = buildCmsBag(check.cmsCalls);
      const fields = evaluateFields(getContracts(check.view), rawBag, cmsBag, {
        role: check.role,
        granularity: fixtures.granularity
      });
      const status = aggregateStatus(fields);
      assert.strictEqual(status, check.status, `${check.view}/${check.role} status drift`);
      for (const recorded of check.fields) {
        const now = fields.find((f) => f.key === recorded.key);
        assert.ok(now, `missing field ${recorded.key}`);
        assert.strictEqual(now.pass, recorded.pass, `${check.view}/${check.role} ${recorded.key} pass drift`);
      }
    }
  });

  it('reports the concrete mismatches (a mismatch is a finding, not a failure of this test)', () => {
    const mismatches = fixtures.checks
      .filter((c) => c.status === 'MISMATCH')
      .map((c) => `${c.view}${c.role ? '/' + c.role : ''}`);
    // Informational: list them for the run log; never assert they are zero.
    assert.ok(Array.isArray(mismatches));
    if (mismatches.length) console.log(`      fixtures mismatches (findings): ${mismatches.join(', ')}`);
  });
});
