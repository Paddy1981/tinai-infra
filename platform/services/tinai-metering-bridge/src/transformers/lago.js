// src/transformers/lago.js
// Transforms Prometheus metric values into Lago /events/batch payload format.
//
// Lago event schema (POST /api/v1/events/batch):
// {
//   events: [{
//     transaction_id: string,   // Idempotency key — same window = same ID
//     external_subscription_id: string,  // Lago subscription for this tenant
//     code: string,             // Lago billable metric code
//     timestamp: number,        // Unix epoch seconds (end of window)
//     properties: {
//       value: string           // The usage quantity (Lago expects string)
//     }
//   }]
// }
//
// Idempotency strategy:
//   transaction_id = sha256(namespace + metricCode + windowStart + windowEnd)
//   This means: re-running the bridge for the same window is safe.
//   Lago will deduplicate on transaction_id and not double-count.

import { createHash } from 'crypto';

/**
 * Derive the Lago external_subscription_id from a K8s namespace name.
 *
 * Convention: namespace = `tenant-{externalId}`
 * e.g. `tenant-acme-corp` → external_subscription_id = `acme-corp`
 *
 * In production you may want to look this up from your PostgreSQL
 * tenants table instead of deriving it from the namespace name.
 */
export function namespaceToSubscriptionId(namespace, prefix = 'tenant-') {
  if (!namespace.startsWith(prefix)) {
    throw new Error(`Namespace "${namespace}" does not start with expected prefix "${prefix}"`);
  }
  return namespace.slice(prefix.length);
}

/**
 * Deterministic transaction ID for idempotent Lago event submission.
 * Same inputs always produce the same ID — safe to re-run on crash.
 */
export function buildTransactionId(namespace, metricCode, windowStart, windowEnd) {
  return createHash('sha256')
    .update(`${namespace}:${metricCode}:${windowStart}:${windowEnd}`)
    .digest('hex')
    .slice(0, 32); // Lago accepts up to 128 chars; 32 hex chars is plenty
}

/**
 * Convert collected metrics for one namespace into Lago batch event objects.
 *
 * @param {string} namespace        - K8s namespace (e.g. "tenant-acme-corp")
 * @param {object} metrics          - { compute_seconds: 3600, egress_bytes: 10485760, ... }
 * @param {number} windowStart      - ms since epoch (start of collection window)
 * @param {number} windowEnd        - ms since epoch (end of collection window)
 * @param {string} nsPrefix         - Tenant namespace prefix
 * @returns {object[]}              - Array of Lago event objects
 */
export function transformToLagoEvents(namespace, metrics, windowStart, windowEnd, nsPrefix = 'tenant-') {
  const externalSubscriptionId = namespaceToSubscriptionId(namespace, nsPrefix);
  const timestamp = Math.floor(windowEnd / 1000); // Lago wants Unix seconds

  const events = [];

  for (const [metricCode, rawValue] of Object.entries(metrics)) {
    // Round to 4 decimal places — sub-millicent precision is meaningless
    const value = Math.round(rawValue * 10000) / 10000;

    events.push({
      transaction_id: buildTransactionId(namespace, metricCode, windowStart, windowEnd),
      external_subscription_id: externalSubscriptionId,
      code: metricCode,
      timestamp,
      properties: {
        // Lago requires value as a string for aggregation metric types
        value: String(value),
      },
    });
  }

  return events;
}

/**
 * Split a flat array of events into batches of `batchSize`.
 * Lago recommends <= 100 events per batch call.
 */
export function chunkEvents(events, batchSize = 100) {
  const chunks = [];
  for (let i = 0; i < events.length; i += batchSize) {
    chunks.push(events.slice(i, i + batchSize));
  }
  return chunks;
}
