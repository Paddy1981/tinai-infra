// src/index.js
// Entry point for the Tinai metering bridge.
// Responsibilities:
//   - Validate config
//   - Connect to NATS
//   - Start the collection scheduler
//   - Start the health HTTP server
//   - Handle graceful shutdown

import pino from 'pino';
import { connect as natsConnect } from 'nats';
import { config, validateConfig } from '../config/index.js';
import { runMeteringCycle } from './metering-runner.js';
import { createHealthServer } from './health/server.js';

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
  }),
});

// ── Shared state (mutated by scheduler, read by health server) ────────────────
const state = {
  schedulerAlive: false,
  lastRunAt: null,
  nextRunAt: null,
  lastSummary: null,
};

// ── NATS connection ────────────────────────────────────────────────────────────
async function connectNATS() {
  try {
    const nc = await natsConnect({ servers: config.nats.servers });
    logger.info({ servers: config.nats.servers }, 'Connected to NATS');

    // Reconnect on unexpected close
    nc.closed().then(err => {
      if (err) logger.error({ err: err.message }, 'NATS connection closed unexpectedly');
    });

    return nc;
  } catch (err) {
    logger.warn({ err: err.message }, 'NATS unavailable — continuing without audit/DLQ trail');
    return null;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function startScheduler(natsClient) {
  state.schedulerAlive = true;

  // Track the last collection window end-time to avoid gaps.
  // On first run, look back by lookbackMs to catch any gap from startup.
  let lastWindowEnd = Date.now() - config.schedule.lookbackMs;

  async function tick() {
    const windowStart = lastWindowEnd;
    const windowEnd = Date.now();

    try {
      const summary = await runMeteringCycle(windowStart, windowEnd, natsClient, logger);
      state.lastSummary = summary;
      state.lastRunAt = Date.now();
      lastWindowEnd = windowEnd; // advance window only on success
    } catch (err) {
      // Catch-all so the scheduler never dies from an unhandled error
      logger.error({ err: err.message, stack: err.stack }, 'Unhandled error in metering cycle');
      // Don't advance lastWindowEnd — next run will retry the same window
    }

    // Schedule next tick
    const nextRun = Date.now() + config.schedule.intervalMs;
    state.nextRunAt = nextRun;
    const delay = Math.max(0, nextRun - Date.now());
    setTimeout(tick, delay);
    logger.info({ nextRunAt: new Date(nextRun).toISOString() }, 'Next metering run scheduled');
  }

  // Run immediately on startup, then on schedule
  logger.info({ intervalMs: config.schedule.intervalMs }, 'Scheduler starting');
  tick();
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────
function setupShutdown(natsClient, healthServer) {
  async function shutdown(signal) {
    logger.info({ signal }, 'Shutdown signal received');
    state.schedulerAlive = false;

    try {
      await healthServer.close();
      logger.info('Health server closed');
    } catch (e) {
      logger.warn('Health server close error (ignored)');
    }

    if (natsClient) {
      await natsClient.drain();
      logger.info('NATS drained');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', err => {
    logger.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
async function main() {
  logger.info({ version: config.service.version }, `Starting ${config.service.name}`);

  try {
    validateConfig();
  } catch (err) {
    logger.fatal({ err: err.message }, 'Invalid configuration — exiting');
    process.exit(1);
  }

  const natsClient = await connectNATS();

  // Health server needs a reference to the manual trigger function
  const triggerRun = async () => {
    const windowEnd = Date.now();
    const windowStart = windowEnd - config.schedule.intervalMs;
    return runMeteringCycle(windowStart, windowEnd, natsClient, logger);
  };

  const healthServer = createHealthServer(state, triggerRun, logger);
  await healthServer.listen({ port: config.service.port, host: '0.0.0.0' });
  logger.info({ port: config.service.port }, 'Health server listening');

  setupShutdown(natsClient, healthServer);
  startScheduler(natsClient);
}

main();
