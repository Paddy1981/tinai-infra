// src/health/server.js
// Tiny Fastify HTTP server exposing:
//   GET /health   — liveness probe (K8s kills pod if this fails)
//   GET /ready    — readiness probe (K8s stops routing traffic if this fails)
//   GET /metrics  — last run summary (for Prometheus scraping / manual check)
//   POST /run     — trigger an immediate metering run (admin use, dev testing)

import Fastify from 'fastify';
import { config } from '../../config/index.js';

export function createHealthServer(state, triggerRun, logger) {
  const app = Fastify({ logger: false }); // use our own pino logger

  // ── Liveness ──────────────────────────────────────────────────────────────
  // Pod is alive if the process is running. Always returns 200 unless
  // the scheduler has stopped (e.g. unhandled exception in run loop).
  app.get('/health', async (_req, reply) => {
    if (!state.schedulerAlive) {
      return reply.code(503).send({ status: 'unhealthy', reason: 'scheduler stopped' });
    }
    return reply.send({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // ── Readiness ─────────────────────────────────────────────────────────────
  // Pod is ready once it has completed at least one successful run.
  // On startup, readiness fails until first cycle completes.
  app.get('/ready', async (_req, reply) => {
    if (!state.lastRunAt) {
      return reply.code(503).send({ status: 'not ready', reason: 'no completed run yet' });
    }

    // Also fail readiness if last run was > 3× interval ago (stuck scheduler)
    const staleness = Date.now() - state.lastRunAt;
    const maxStaleness = config.schedule.intervalMs * 3;
    if (staleness > maxStaleness) {
      return reply.code(503).send({
        status: 'not ready',
        reason: 'last run too stale',
        staleSecs: Math.round(staleness / 1000),
      });
    }

    return reply.send({ status: 'ready', lastRunAt: new Date(state.lastRunAt).toISOString() });
  });

  // ── Metrics / last run summary ────────────────────────────────────────────
  app.get('/metrics', async (_req, reply) => {
    return reply.send({
      service: config.service.name,
      version: config.service.version,
      uptime: Math.round(process.uptime()),
      intervalMs: config.schedule.intervalMs,
      lastRun: state.lastSummary ?? null,
      nextRunAt: state.nextRunAt ? new Date(state.nextRunAt).toISOString() : null,
      schedulerAlive: state.schedulerAlive,
    });
  });

  // ── Manual trigger ────────────────────────────────────────────────────────
  // Useful during development or for ops-triggered catch-up runs.
  // Protect with a simple token in production.
  app.post('/run', async (req, reply) => {
    const token = req.headers['x-admin-token'];
    if (token !== process.env.ADMIN_TOKEN && process.env.NODE_ENV !== 'development') {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    logger.info('Manual metering run triggered via /run endpoint');
    // Trigger async — don't await so HTTP responds immediately
    triggerRun().catch(err => logger.error({ err: err.message }, 'Manual run failed'));

    return reply.code(202).send({ status: 'accepted', message: 'Metering run started' });
  });

  return app;
}
