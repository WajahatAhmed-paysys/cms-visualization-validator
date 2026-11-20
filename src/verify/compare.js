'use strict';

/**
 * Comparison engine for Data Verify.
 *
 * Kinds and default tolerances:
 *   count   -> exact (tolerance 0)
 *   money   -> 0.01
 *   percent -> 0.01
 *   date    -> 1000 ms
 *   string / bool -> exact
 *   informational -> never fails (no independent oracle)
 *   optional -> reported but not required for a view's status
 */

const EMPTY_STRINGS = new Set(['no data found']);

function normalise(kind, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && EMPTY_STRINGS.has(value.trim().toLowerCase())) return null;

  if (kind === 'money' || kind === 'percent' || kind === 'count' || kind === 'informational') {
    if (typeof value === 'string') {
      const cleaned = value.replace(/[,$%\s]/g, '');
      return cleaned === '' ? null : Number(cleaned);
    }
    return Number(value);
  }
  if (kind === 'date') {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (kind === 'bool') {
    if (typeof value === 'string') return value === 'true' || value === '1';
    return Boolean(value);
  }
  return String(value).trim();
}

function defaultTolerance(kind) {
  if (kind === 'count') return 0;
  if (kind === 'money') return 0.01;
  if (kind === 'percent') return 0.01;
  if (kind === 'date') return 1000;
  return 0;
}

function compareField(field, expected, actual) {
  const kind = field.kind || 'string';

  // Fields with no independent oracle: reported but never a failure.
  if (kind === 'informational' || field.required === false) {
    return { pass: true, delta: null, informational: kind === 'informational' || field.required === false };
  }

  const e = normalise(kind, expected);
  const a = normalise(kind, actual);
  if (e === null && a === null) return { pass: true, delta: 0 };
  if (e === null || a === null) return { pass: false, delta: null, reason: 'one side empty' };

  if (['money', 'percent', 'count'].includes(kind)) {
    const tolerance = field.tolerance != null ? field.tolerance : defaultTolerance(kind);
    const delta = Math.abs(e - a);
    return { pass: delta <= tolerance + 1e-9, delta };
  }
  if (kind === 'date') {
    const tolerance = field.tolerance != null ? field.tolerance : field.toleranceMs != null ? field.toleranceMs : 1000;
    const delta = Math.abs(e - a);
    return { pass: delta <= tolerance, delta };
  }
  if (kind === 'bool') {
    return { pass: Boolean(e) === Boolean(a), delta: null };
  }
  const pass = String(e) === String(a);
  return { pass, delta: pass ? 0 : null };
}

module.exports = { normalise, compareField, defaultTolerance };
