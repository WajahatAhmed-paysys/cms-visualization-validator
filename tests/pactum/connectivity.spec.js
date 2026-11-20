'use strict';

/**
 * PactumJS integration smoke tests against a live environment.
 *
 * These are skipped unless RUN_INTEGRATION=1 is set, because they require the
 * CMS backend and Gold Lakehouse to be reachable. They are read-only: health
 * checks, a login, and a single trivial /execute_sql count.
 *
 *   RUN_INTEGRATION=1 npm run test:pactum
 */

const assert = require('assert');
const config = require('../../src/config');

const enabled = process.env.RUN_INTEGRATION === '1' && Boolean(config.username && config.password);
const describeOrSkip = enabled ? describe : describe.skip;

describeOrSkip('PactumJS connectivity (live)', function () {
  this.timeout(90000);

  let token;

  it('logs in to the CMS and stores a bearer token', async () => {
    const { spec } = require('pactum');
    const response = await spec()
      .post(`${config.cmsBaseUrl}/v1/auth/login`)
      .withHeaders({ 'Content-Type': 'application/json' })
      .withBody({ username: config.username, password: config.password })
      .returns('response');

    assert.strictEqual(response.statusCode, 200);
    token = response.body.token || response.body.access_token;
    assert.strictEqual(typeof token, 'string');
    assert.ok(token.length > 10);
  });

  it('reports Lakehouse health', async () => {
    const { spec } = require('pactum');
    const response = await spec()
      .get(`${config.lakehouseBaseUrl}/health`)
      .withHeaders({ Authorization: `Bearer ${token}` })
      .returns('response');
    assert.strictEqual(response.statusCode, 200);
  });

  it('lists Lakehouse tables', async () => {
    const { spec } = require('pactum');
    const response = await spec()
      .get(`${config.lakehouseBaseUrl}/tables`)
      .withHeaders({ Authorization: `Bearer ${token}` })
      .returns('response');
    assert.strictEqual(response.statusCode, 200);
  });

  it('runs a trivial read-only /execute_sql against transaction_detail', async () => {
    const { spec } = require('pactum');
    const response = await spec()
      .post(`${config.lakehouseBaseUrl}/execute_sql`)
      .withHeaders({ Authorization: `Bearer ${token}` })
      .withBody({
        sql_query: `SELECT count(*) AS n FROM transaction_detail WHERE tenant_id = '${config.tenantId.replace(/'/g, "''")}'`,
        limit: 1
      })
      .returns('response');
    assert.strictEqual(response.statusCode, 200);
  });
});
