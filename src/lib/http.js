'use strict';

const { spec, request, settings } = require('pactum');
const config = require('../config');
const log = require('./logger');

// Pactum is used as the HTTP client for every request this tool makes.
settings.setLogLevel('SILENT');
request.setDefaultTimeout(config.requestTimeoutMs);

function cleanQuery(query) {
  if (!query) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Execute one HTTP request through PactumJS.
 *
 * Never throws for HTTP status codes: a 4xx/5xx is returned as `ok: false`
 * with the status and body intact so the status engine can classify it.
 * Network-level failures (DNS, refused, timeout) are also returned, not thrown.
 */
async function http({ method = 'GET', url, query, headers, body, timeoutMs }) {
  const startedAt = Date.now();
  const requestHeaders = { Accept: 'application/json', ...(headers || {}) };
  const requestRecord = {
    method,
    url,
    query: cleanQuery(query) || null,
    body: body === undefined ? null : body
  };

  let pactumSpec = spec().withHeaders(requestHeaders);
  const params = cleanQuery(query);
  if (params) pactumSpec = pactumSpec.withQueryParams(params);
  if (timeoutMs) pactumSpec = pactumSpec.withRequestTimeout(timeoutMs);

  try {
    let response;
    if (method === 'GET') {
      response = await pactumSpec.get(url);
    } else if (method === 'POST') {
      response = await pactumSpec.post(url).withBody(body === undefined ? {} : body);
    } else if (method === 'HEAD') {
      response = await pactumSpec.head(url);
    } else if (method === 'DELETE') {
      response = await pactumSpec.delete(url);
    } else {
      throw new Error(`Unsupported HTTP method: ${method}`);
    }

    const statusCode = Number(response && response.statusCode);
    const durationMs = Date.now() - startedAt;
    const responseBody = response ? response.body : undefined;

    return {
      ok: statusCode >= 200 && statusCode < 300,
      statusCode,
      body: responseBody,
      headers: response ? response.headers : undefined,
      durationMs,
      request: requestRecord,
      error: null
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    log.debug(`HTTP failure ${method} ${url}: ${error && error.message}`);
    return {
      ok: false,
      statusCode: null,
      body: null,
      headers: null,
      durationMs,
      request: requestRecord,
      error: {
        code: classifyNetworkError(error),
        message: error && error.message ? error.message : String(error)
      }
    };
  }
}

function classifyNetworkError(error) {
  const message = String((error && error.message) || error || '');
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'UPSTREAM_TIMEOUT';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(message)) return 'NETWORK_UNREACHABLE';
  if (/certificate|TLS|SSL/i.test(message)) return 'NETWORK_UNREACHABLE';
  return 'REQUEST_FAILED';
}

module.exports = { http, cleanQuery };
