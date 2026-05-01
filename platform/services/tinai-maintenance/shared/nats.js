// shared/nats.js
// Shared NATS connection factory with reconnect, publish helpers, and DLQ.

import { connect, JSONCodec } from 'nats';
import { config } from './config.js';

const jc = JSONCodec();

export async function connectNATS(logger) {
  try {
    const nc = await connect({
      servers: config.nats.servers,
      reconnect: true,
      maxReconnectAttempts: -1, // infinite
      reconnectTimeWait: 2000,
    });
    logger?.info({ servers: config.nats.servers }, 'NATS connected');
    nc.closed().then(err => {
      if (err) logger?.error({ err: err.message }, 'NATS connection lost');
    });
    return nc;
  } catch (err) {
    logger?.warn({ err: err.message }, 'NATS unavailable — audit/events disabled');
    return null;
  }
}

export function publish(nc, subject, data, logger) {
  if (!nc) return;
  try {
    nc.publish(subject, jc.encode(data));
  } catch (err) {
    logger?.warn({ err: err.message, subject }, 'NATS publish failed');
  }
}

export async function publishToDLQ(nc, payload, error, service, logger) {
  if (!nc) {
    logger?.error({ payload, error: error?.message }, 'DLQ unavailable — event lost');
    return;
  }
  publish(nc, config.nats.subjects.dlq, {
    timestamp: new Date().toISOString(),
    service,
    error: error?.message ?? 'unknown',
    payload,
  }, logger);
  logger?.warn({ service }, 'Event sent to DLQ');
}

export function publishAudit(nc, data, logger) {
  publish(nc, config.nats.subjects.audit, {
    timestamp: new Date().toISOString(),
    ...data,
  }, logger);
}
