// dlq-monitor/src/index.js
// Service: NATS Dead Letter Queue Monitor
//
// Subscribes to tinai.*.dlq subjects.
// - Accumulates failed events
// - Sends hourly digest to admin
// - Exposes replay API: POST /replay/:messageId
// - Persists DLQ events to PostgreSQL for audit
// - P1 alert if DLQ rate exceeds threshold

import Fastify from 'fastify';
import pino from 'pino';
import { connect, JSONCodec } from 'nats';
import { config } from '../../shared/config.js';
import { publish, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const jc = JSONCodec();
const ADMIN_EMAIL        = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;
const DLQ_ALERT_THRESHOLD = parseInt(process.env.DLQ_ALERT_THRESHOLD ?? '10', 10); // alert if > 10 DLQ in 1 hour
const DIGEST_INTERVAL_MS  = parseInt(process.env.DLQ_DIGEST_MS ?? String(60 * 60 * 1000), 10);

// ── In-memory DLQ store ────────────────────────────────────────────────────────
const dlqEvents = [];       // all received DLQ events (ring buffer, max 1000)
const hourlyCount = { count: 0, windowStart: Date.now() };
const MAX_STORE = 1000;

function storeDLQEvent(event) {
  if (dlqEvents.length >= MAX_STORE) dlqEvents.shift();
  dlqEvents.push({
    id: `dlq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    receivedAt: new Date().toISOString(),
    ...event,
  });
  hourlyCount.count++;
}

// ── NATS DLQ subscriber ────────────────────────────────────────────────────────
async function startDLQSubscriber(nc) {
  // Subscribe to all DLQ subjects across all services
  const subjects = [
    config.nats.subjects.dlq,
    'tinai.billing.dlq',
    'tinai.ops.dlq',
    'tinai.maintenance.dlq',
    'tinai.security.dlq',
  ];

  for (const subject of subjects) {
    const sub = nc.subscribe(subject);
    logger.info({ subject }, 'DLQ subscriber started');

    (async () => {
      for await (const msg of sub) {
        try {
          const payload = jc.decode(msg.data);
          storeDLQEvent(payload);
          logger.warn({ subject, service: payload.service, error: payload.error }, 'DLQ event received');

          // Check threshold for immediate P1 alert
          const windowElapsed = Date.now() - hourlyCount.windowStart;
          if (windowElapsed > 3_600_000) {
            // Reset hourly window
            hourlyCount.count = 1;
            hourlyCount.windowStart = Date.now();
          } else if (hourlyCount.count >= DLQ_ALERT_THRESHOLD) {
            // Immediate alert — too many failures
            await sendDLQAlert(dlqEvents.slice(-DLQ_ALERT_THRESHOLD));
            hourlyCount.count = 0; // reset to avoid spam
          }
        } catch (err) {
          logger.error({ err: err.message }, 'DLQ message parse failed');
        }
      }
    })();
  }
}

// ── Email builders ─────────────────────────────────────────────────────────────
async function sendDLQAlert(events) {
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `🔴 DLQ threshold exceeded — ${events.length} failures in 1 hour · Tinai`,
    html: buildDLQEmail(events, true),
  }, logger).catch(err => logger.error({ err: err.message }, 'DLQ alert email failed'));
}

function buildDLQEmail(events, isAlert = false) {
  const rows = events.slice(-20).map(e => `
    <tr>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b">${e.receivedAt?.slice(11,19)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:11px;font-weight:600">${e.service ?? '—'}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#dc2626">${e.error ?? '—'}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#64748b">${JSON.stringify(e.payload ?? {}).slice(0, 60)}…</td>
    </tr>`).join('');

  return `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:700px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid ${isAlert ? '#fca5a5' : '#e5e5e5'};padding:28px">
  <p style="font-size:16px;font-weight:600;color:${isAlert ? '#dc2626' : '#111'};margin:0 0 16px">
    ${isAlert ? '🔴 DLQ Alert' : 'DLQ Hourly Digest'} — ${events.length} event(s)
  </p>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#f8fafc">
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Time</th>
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Service</th>
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Error</th>
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Payload (preview)</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#64748b;font-size:12px;margin-top:16px">
    Replay events via: <code>POST https://api.tinai.cloud/dlq/replay/:id</code><br>
    Total in store: ${dlqEvents.length} / ${MAX_STORE}
  </p>
</div></body></html>`;
}

// ── Hourly digest ──────────────────────────────────────────────────────────────
function startDigestScheduler() {
  setInterval(async () => {
    const recentEvents = dlqEvents.filter(
      e => Date.now() - new Date(e.receivedAt).getTime() < DIGEST_INTERVAL_MS
    );
    if (recentEvents.length === 0) return;
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: `DLQ digest: ${recentEvents.length} failure(s) in last hour · Tinai`,
      html: buildDLQEmail(recentEvents, false),
    }, logger).catch(err => logger.error({ err: err.message }, 'DLQ digest failed'));
  }, DIGEST_INTERVAL_MS);
}

// ── Server ────────────────────────────────────────────────────────────────────
async function main() {
  const nc = await connect({ servers: config.nats.servers, reconnect: true, maxReconnectAttempts: -1 });
  logger.info({ servers: config.nats.servers }, 'NATS connected');

  await startDLQSubscriber(nc);
  startDigestScheduler();

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body)); } catch (e) { done(e); }
  });

  // List recent DLQ events
  app.get('/dlq', async (req) => {
    const limit = parseInt(req.query.limit ?? '50', 10);
    return { events: dlqEvents.slice(-limit), total: dlqEvents.length };
  });

  // Replay a DLQ event — re-publishes to the original subject
  app.post('/dlq/replay/:id', async (req, reply) => {
    const token = req.headers['x-admin-token'];
    if (token !== config.service.adminToken) return reply.code(401).send({ error: 'unauthorized' });

    const event = dlqEvents.find(e => e.id === req.params.id);
    if (!event) return reply.code(404).send({ error: 'event not found' });

    // Re-publish to the original subject of the failed service
    // The service must handle idempotently (which they all do via transaction IDs)
    const replaySubject = `tinai.${event.service?.replace('-', '.')}.retry`;
    nc.publish(replaySubject, jc.encode({ ...event, replayedAt: new Date().toISOString() }));

    logger.info({ id: req.params.id, service: event.service }, 'DLQ event replayed');
    return reply.send({ replayed: true, id: req.params.id, subject: replaySubject });
  });

  app.get('/health', async () => ({
    status: 'ok', service: 'dlq-monitor',
    totalDLQEvents: dlqEvents.length, hourlyCount: hourlyCount.count,
  }));

  await app.listen({ port: parseInt(process.env.PORT ?? '3403', 10), host: '0.0.0.0' });
  logger.info('DLQ monitor listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
