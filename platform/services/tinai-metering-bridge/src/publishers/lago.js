// src/publishers/lago.js
// Posts metering events to Lago billing engine.
// Implements retry with exponential backoff and DLQ fallback via NATS.

import { config } from '../../config/index.js';
import { chunkEvents } from '../transformers/lago.js';

const LAGO_EVENTS_ENDPOINT = `${config.lago.url}/api/v1/events/batch`;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST a single batch of events to Lago.
 * Returns true on success, throws on non-retryable error.
 */
async function postBatch(events, attempt = 1) {
  const res = await fetch(LAGO_EVENTS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.lago.apiKey}`,
    },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(15_000),
  });

  if (res.ok) return true;

  const body = (await res.text()).slice(0, 500);

  // 422 = validation error (bad metric code, unknown subscription) — not retryable
  if (res.status === 422) {
    throw Object.assign(new Error(`Lago validation error: ${body}`), { retryable: false });
  }

  // 429 = rate limited — retryable
  // 5xx = server error — retryable
  if (res.status === 429 || res.status >= 500) {
    throw Object.assign(
      new Error(`Lago HTTP ${res.status}: ${body}`),
      { retryable: true }
    );
  }

  // 401/403 — auth error, not retryable
  throw Object.assign(
    new Error(`Lago auth error HTTP ${res.status}: ${body}`),
    { retryable: false }
  );
}

/**
 * Post batch with exponential backoff retry.
 */
async function postBatchWithRetry(events, logger) {
  let lastError;

  for (let attempt = 1; attempt <= config.lago.retryAttempts; attempt++) {
    try {
      await postBatch(events, attempt);
      return { success: true };
    } catch (err) {
      lastError = err;

      if (!err.retryable) {
        logger.error({ err: err.message, eventCount: events.length }, 'Non-retryable Lago error');
        return { success: false, error: err, retryable: false };
      }

      if (attempt < config.lago.retryAttempts) {
        const delay = config.lago.retryDelayMs * Math.pow(2, attempt - 1); // exponential backoff
        logger.warn({ attempt, delay, err: err.message }, 'Lago POST failed — retrying');
        await sleep(delay);
      }
    }
  }

  logger.error({ attempts: config.lago.retryAttempts, err: lastError?.message }, 'Lago POST exhausted retries');
  return { success: false, error: lastError, retryable: true };
}

// ── NATS DLQ ─────────────────────────────────────────────────────────────────

/**
 * Publish failed events to NATS DLQ subject for later investigation/replay.
 * The DLQ consumer (separate service) can alert you or retry on schedule.
 */
async function sendToDLQ(natsClient, events, error, logger) {
  if (!natsClient) {
    logger.error({ eventCount: events.length }, 'No NATS client — DLQ unavailable, events lost!');
    return;
  }

  try {
    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      error: error?.message ?? 'unknown',
      events,
    });

    natsClient.publish(
      config.nats.dlqSubject,
      new TextEncoder().encode(payload)
    );

    logger.warn({ eventCount: events.length, subject: config.nats.dlqSubject }, 'Events sent to DLQ');
  } catch (natsErr) {
    logger.error({ natsErr: natsErr.message }, 'Failed to publish to NATS DLQ — events truly lost');
  }
}

// ── Audit trail ───────────────────────────────────────────────────────────────

async function publishAudit(natsClient, summary, logger) {
  if (!natsClient) return;

  try {
    natsClient.publish(
      config.nats.auditSubject,
      new TextEncoder().encode(JSON.stringify(summary))
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'Audit publish failed — non-critical');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Publish all events for a collection run to Lago.
 * Handles batching, retry, DLQ, and audit trail.
 *
 * @param {object[]} allEvents    - Flat array of Lago event objects
 * @param {object}   natsClient   - Connected NATS client (or null for dry-run)
 * @param {object}   logger       - Pino logger
 * @returns {{ sent: number, failed: number, dlqd: number }}
 */
export async function publishToLago(allEvents, natsClient, logger) {
  const batches = chunkEvents(allEvents, config.lago.batchSize);
  let sent = 0;
  let failed = 0;
  let dlqd = 0;

  logger.info({ totalEvents: allEvents.length, batches: batches.length }, 'Publishing to Lago');

  for (const [i, batch] of batches.entries()) {
    const result = await postBatchWithRetry(batch, logger);

    if (result.success) {
      sent += batch.length;
      logger.debug({ batch: i + 1, count: batch.length }, 'Lago batch accepted');
    } else {
      failed += batch.length;
      await sendToDLQ(natsClient, batch, result.error, logger);
      dlqd += batch.length;
    }
  }

  // Publish audit summary to NATS for compliance reporter
  await publishAudit(natsClient, {
    timestamp: new Date().toISOString(),
    totalEvents: allEvents.length,
    sent,
    failed,
    dlqd,
    service: config.service.name,
  }, logger);

  return { sent, failed, dlqd };
}
