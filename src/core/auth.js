'use strict';

const { http } = require('../lib/http');
const { describeToken } = require('../lib/redact');

class AuthError extends Error {
  constructor(message, code = 'AUTH_INVALID') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * POST <CMS_BACKEND>/v1/auth/login
 * Returns { token, expiresIn, description }.
 */
async function login(ctx) {
  if (!ctx.config.username || !ctx.config.password) {
    throw new AuthError('CMS_USERNAME / CMS_PASSWORD are not set in .env', 'AUTH_MISSING_CREDENTIALS');
  }

  const response = await http({
    method: 'POST',
    url: `${ctx.config.cmsBaseUrl}/v1/auth/login`,
    headers: { 'Content-Type': 'application/json' },
    body: { username: ctx.config.username, password: ctx.config.password },
    timeoutMs: 60000
  });

  if (!response.ok) {
    const status = response.statusCode ? ` (HTTP ${response.statusCode})` : '';
    throw new AuthError(`CMS login failed${status}: ${summarise(response)}`);
  }

  const body = response.body || {};
  const token = body.token || body.access_token || body.accessToken;
  if (!token) {
    throw new AuthError('CMS login responded without a token', 'AUTH_INVALID');
  }

  return {
    token,
    expiresIn: body.expiresIn || body.expires_in || null,
    description: describeToken(token)
  };
}

/** GET <CMS_BACKEND>/v1/auth/me */
async function me(ctx) {
  const response = await http({
    method: 'GET',
    url: `${ctx.config.cmsBaseUrl}/v1/auth/me`,
    headers: authHeaders(ctx.token),
    timeoutMs: 60000
  });

  if (!response.ok) {
    throw new AuthError(`GET /v1/auth/me failed: ${summarise(response)}`, response.statusCode === 401 ? 'AUTH_EXPIRED' : 'AUTH_INVALID');
  }

  return response.body;
}

function summarise(response) {
  if (response.error) return response.error.message;
  const body = response.body;
  if (body && typeof body === 'object') {
    return body.message || body.error || JSON.stringify(body).slice(0, 300);
  }
  return String(body).slice(0, 300);
}

/** Token expiry check with a small safety margin. */
function isExpiring(token, marginSeconds = 60) {
  const description = describeToken(token);
  if (!description.expiresAt) return false;
  return new Date(description.expiresAt).getTime() - Date.now() < marginSeconds * 1000;
}

module.exports = { login, me, authHeaders, isExpiring, AuthError, summarise };
