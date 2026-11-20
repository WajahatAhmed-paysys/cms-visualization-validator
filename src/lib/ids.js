'use strict';

/**
 * Identity quirks of the Lakehouse data:
 *  - `account_holder.source` stores the entity id with a `TAZAMA_EID` suffix.
 *  - account ids returned by `account_holder.destination` may carry an
 *    `MSISDN...` tail that must be stripped before use as an edge key.
 *  - `conditions.entity_id` for entity-level rows is stored bare.
 */

function withEntitySuffix(entityId) {
  const text = String(entityId);
  // The CMS entity-metadata endpoint already returns ids ending in TAZAMA_EID.
  return text.endsWith('TAZAMA_EID') ? text : `${text}TAZAMA_EID`;
}

function cleanAccountId(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  const index = text.indexOf('MSISDN');
  return index >= 0 ? text.slice(0, index) : text;
}

function unique(values) {
  return Array.from(new Set(values.filter((v) => v !== null && v !== undefined && v !== '')));
}

module.exports = { withEntitySuffix, cleanAccountId, unique };
