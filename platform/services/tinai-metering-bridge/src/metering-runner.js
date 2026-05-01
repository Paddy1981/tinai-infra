// src/metering-runner.js
// Orchestrates one full metering cycle:
//   1. Discover tenant namespaces from Prometheus
//   2. Collect usage metrics per namespace
//   3. Transform to Lago events
//   4. Publish to Lago with retry / DLQ
//
// This module is stateless — it receives windowStart/windowEnd and
// a NATS client. The scheduler in index.js manages timing.

import { discoverTenantNamespaces, collectNamespaceMetrics } from './collectors/prometheus.js';
import { transformToLagoEvents } from './transformers/lago.js';
import { publishToLago } from './publishers/lago.js';
import { config } from '../config/index.js';

/**
 * Run one metering cycle over the window [windowStart, windowEnd].
 *
 * @param {number} windowStart  - ms epoch (start of collection window)
 * @param {number} windowEnd    - ms epoch (end of collection window)
 * @param {object} natsClient   - Connected NATS client (nullable in dry-run)
 * @param {object} logger       - Pino logger
 * @returns {object}            - Run summary for health endpoint
 */
export async function runMeteringCycle(windowStart, windowEnd, natsClient, logger) {
  const runId = `run-${windowEnd}`;
  const startedAt = Date.now();

  logger.info({
    runId,
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    windowMinutes: Math.round((windowEnd - windowStart) / 60000),
  }, '── Metering cycle starting ──');

  // ── 1. Discover tenant namespaces ─────────────────────────────────────────
  let namespaces;
  try {
    namespaces = await discoverTenantNamespaces(logger);
  } catch (err) {
    logger.error({ err: err.message }, 'Namespace discovery failed — aborting cycle');
    return { runId, status: 'failed', error: err.message, durationMs: Date.now() - startedAt };
  }

  if (namespaces.length === 0) {
    logger.warn({ runId }, 'No tenant namespaces found — nothing to meter');
    return { runId, status: 'empty', namespacesFound: 0, durationMs: Date.now() - startedAt };
  }

  // ── 2. Collect metrics per namespace (concurrent, capped) ─────────────────
  // Run up to 5 Prometheus queries concurrently to avoid overwhelming it.
  const CONCURRENCY = 5;
  const allEvents = [];
  const skipped = [];
  const errors = [];

  for (let i = 0; i < namespaces.length; i += CONCURRENCY) {
    const batch = namespaces.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async ns => {
        const metrics = await collectNamespaceMetrics(ns, windowStart, windowEnd, logger);
        return { ns, metrics };
      })
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push({ ns: 'unknown', error: result.reason?.message });
        continue;
      }

      const { ns, metrics } = result.value;

      if (metrics === null) {
        skipped.push(ns);
        continue;
      }

      // ── 3. Transform to Lago events ───────────────────────────────────────
      const events = transformToLagoEvents(
        ns,
        metrics,
        windowStart,
        windowEnd,
        config.tenants.namespacePrefix
      );

      allEvents.push(...events);

      logger.debug({
        ns,
        metrics: Object.fromEntries(
          Object.entries(metrics).map(([k, v]) => [k, Math.round(v * 100) / 100])
        ),
        events: events.length,
      }, 'Namespace metered');
    }
  }

  // ── 4. Publish to Lago ────────────────────────────────────────────────────
  let publishResult = { sent: 0, failed: 0, dlqd: 0 };

  if (allEvents.length > 0) {
    publishResult = await publishToLago(allEvents, natsClient, logger);
  } else {
    logger.info({ runId }, 'No events to publish — all tenants idle or skipped');
  }

  const durationMs = Date.now() - startedAt;

  const summary = {
    runId,
    status: publishResult.failed === 0 ? 'success' : 'partial',
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    namespacesFound: namespaces.length,
    namespacesSkipped: skipped.length,
    namespacesErrored: errors.length,
    eventsGenerated: allEvents.length,
    eventsSent: publishResult.sent,
    eventsFailed: publishResult.failed,
    eventsDlqd: publishResult.dlqd,
    durationMs,
  };

  logger.info(summary, '── Metering cycle complete ──');
  return summary;
}
