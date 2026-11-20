'use strict';

const SECRET_KEYS = /^(authorization|password|token|access_token|cookie|set-cookie|service_token)$/i;

/** Deep-copy a value while removing credential-bearing fields. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEYS.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redact(entry);
      }
    }
    return out;
  }
  return value;
}

/** Decode a JWT payload without verifying it (diagnostics only). */
function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (error) {
    return null;
  }
}

/** Safe token description for logs: never the token itself. */
function describeToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return { present: Boolean(token), format: 'unknown' };
  return {
    present: true,
    sub: payload.sub || payload.username || payload.email || null,
    jti: payload.jti || null,
    tenantId: payload.tenantId || payload.tenant_id || null,
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null
  };
}

/** Truncate large payloads for on-disk artifacts. */
function truncateResponse(body, { maxRows = 100, maxBytes = 200000 } = {}) {
  if (body === null || body === undefined) return body;
  let copy = body;
  if (Array.isArray(copy) && copy.length > maxRows) {
    copy = { truncated: true, totalRows: copy.length, rows: copy.slice(0, maxRows) };
  } else if (copy && typeof copy === 'object' && Array.isArray(copy.data) && copy.data.length > maxRows) {
    copy = {
      ...copy,
      truncated: true,
      row_count_shown: maxRows,
      data: copy.data.slice(0, maxRows)
    };
  }
  try {
    if (Buffer.byteLength(JSON.stringify(copy)) > maxBytes) {
      return { truncated: true, note: `payload exceeded ${maxBytes} bytes and was omitted` };
    }
  } catch (error) {
    return { truncated: true, note: 'payload could not be serialised' };
  }
  return copy;
}

module.exports = { redact, decodeJwtPayload, describeToken, truncateResponse };
