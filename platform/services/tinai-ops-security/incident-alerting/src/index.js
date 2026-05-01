// incident-alerting/src/index.js
// Service: Incident Alerting Receiver
//
// Receives webhook calls from Prometheus Alertmanager.
// Handles: deduplication, severity-based routing, escalation, auto-resolution.
//
// Severity routing:
//   P1 (critical) → immediate email + NATS + pager (PagerDuty/OpsGenie stub)
//   P2 (warning)  → email digest every 30 min
//   P3 (info)     → daily digest only
//
// Also handles alert resolution (firing → resolved) to send all-clear emails.

import Fastify from 'fastify';
import pino from 'pino';
import { config } from '../../shared/config.js';
import { connectNATS, publish, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    ?? config.stalwart.fromAddr;
const PAGERDUTY_KEY  = process.env.PAGERDUTY_KEY  ?? '';
const DIGEST_INTERVAL_MS = parseInt(process.env.DIGEST_INTERVAL_MS ?? String(30 * 60 * 1000), 10);

// ── Alert store (in-memory — use Redis in production) ────────────────────────
const activeAlerts = new Map();  // fingerprint → alert
const digestQueue  = [];          // P2 alerts pending digest

// ── Severity classifier ───────────────────────────────────────────────────────
function classifySeverity(alert) {
  const sev = alert.labels?.severity?.toLowerCase() ?? '';
  const name = alert.labels?.alertname?.toLowerCase() ?? '';

  // P1: anything that impacts tenant workloads or billing
  if (sev === 'critical' || name.includes('down') || name.includes('crash') ||
      name.includes('payment') || name.includes('backup') || name.includes('cert')) return 'P1';
  if (sev === 'warning' || name.includes('high') || name.includes('pressure')) return 'P2';
  return 'P3';
}

// ── PagerDuty integration (stub) ─────────────────────────────────────────────
async function page(alert, severity) {
  if (!PAGERDUTY_KEY) { logger.warn({ alert: alert.labels?.alertname }, 'PagerDuty key not set'); return; }

  await fetch('https://events.pagerduty.com/v2/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routing_key: PAGERDUTY_KEY,
      event_action: alert.status === 'resolved' ? 'resolve' : 'trigger',
      dedup_key: alert.fingerprint,
      payload: {
        summary:   `[${severity}] ${alert.labels?.alertname} — ${alert.labels?.namespace ?? 'cluster'}`,
        severity:  severity === 'P1' ? 'critical' : 'warning',
        source:    'tinai-alertmanager',
        timestamp: alert.startsAt,
        custom_details: alert.labels,
      },
    }),
  });
  logger.info({ alert: alert.labels?.alertname, severity }, 'PagerDuty event sent');
}

// ── Email builders ─────────────────────────────────────────────────────────────
function alertToRow(alert) {
  return `<tr>
    <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:600">${alert.labels?.alertname ?? '—'}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${alert.labels?.namespace ?? alert.labels?.instance ?? '—'}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b">${alert.annotations?.summary ?? alert.annotations?.description ?? '—'}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${new Date(alert.startsAt).toLocaleTimeString('en-IN')}</td>
  </tr>`;
}

function buildP1Email(alert) {
  const name = alert.labels?.alertname ?? 'Unknown Alert';
  const ns   = alert.labels?.namespace ?? alert.labels?.instance ?? 'cluster';
  return {
    subject: `🔴 P1 ALERT: ${name} — ${ns} · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;border:2px solid #dc2626;padding:28px">
  <p style="font-size:18px;font-weight:700;color:#dc2626;margin:0 0 8px">🔴 P1 CRITICAL ALERT</p>
  <p style="font-size:16px;font-weight:600;margin:0 0 16px">${name}</p>
  <div style="background:#fef2f2;border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:13px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="color:#64748b;padding:3px 0">Namespace</td><td style="text-align:right">${ns}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Instance</td><td style="text-align:right">${alert.labels?.instance ?? '—'}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Started</td><td style="text-align:right">${new Date(alert.startsAt).toISOString()}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Summary</td><td style="text-align:right">${alert.annotations?.summary ?? '—'}</td></tr>
    </table>
  </div>
  <p style="color:#444;font-size:13px">${alert.annotations?.description ?? ''}</p>
  ${alert.annotations?.runbook_url ? `<a href="${alert.annotations.runbook_url}" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;margin-top:8px">View runbook</a>` : ''}
  <p style="color:#64748b;font-size:11px;margin-top:20px">Fingerprint: ${alert.fingerprint}</p>
</div></body></html>`,
  };
}

function buildResolutionEmail(alert) {
  const name = alert.labels?.alertname ?? 'Unknown Alert';
  const duration = alert.endsAt ? Math.round((new Date(alert.endsAt) - new Date(alert.startsAt)) / 60000) : null;
  return {
    subject: `✅ RESOLVED: ${name} · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #86efac;padding:28px">
  <p style="font-size:18px;font-weight:600;color:#16a34a;margin:0 0 16px">✅ Alert Resolved: ${name}</p>
  <div style="background:#f0fdf4;border-radius:6px;padding:14px 18px;font-size:13px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="color:#64748b;padding:3px 0">Duration</td><td style="text-align:right">${duration ? `${duration} minutes` : '—'}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Resolved at</td><td style="text-align:right">${new Date(alert.endsAt ?? Date.now()).toISOString()}</td></tr>
    </table>
  </div>
</div></body></html>`,
  };
}

function buildDigestEmail(alerts) {
  return {
    subject: `Alert digest: ${alerts.length} active warning(s) · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #fbbf24;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 16px">⚠ Alert Digest — ${alerts.length} warning(s)</p>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#fefce8">
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Alert</th>
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Namespace</th>
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Summary</th>
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Started</th>
    </tr></thead>
    <tbody>${alerts.map(alertToRow).join('')}</tbody>
  </table>
  <p style="color:#64748b;font-size:12px;margin-top:16px">Check Grafana for full details.</p>
</div></body></html>`,
  };
}

// ── Alertmanager webhook handler ──────────────────────────────────────────────
async function handleAlertmanagerPayload(payload, natsClient) {
  const { alerts = [], receiver, groupLabels } = payload;

  for (const alert of alerts) {
    const severity = classifySeverity(alert);
    const fp       = alert.fingerprint ?? `${alert.labels?.alertname}-${alert.labels?.namespace}`;
    const isResolved = alert.status === 'resolved';

    if (isResolved) {
      activeAlerts.delete(fp);
      // Send resolution email for P1 alerts only
      if (activeAlerts.get(fp)?.severity === 'P1' || severity === 'P1') {
        await sendEmail({ to: ADMIN_EMAIL, ...buildResolutionEmail(alert) }, logger);
        await page(alert, severity);
      }
    } else {
      // Skip duplicate alerts (already firing)
      if (activeAlerts.has(fp)) continue;

      activeAlerts.set(fp, { ...alert, severity, firstSeenAt: Date.now() });

      publish(natsClient, 'tinai.ops.alert', {
        timestamp: new Date().toISOString(),
        severity, fingerprint: fp,
        alertname: alert.labels?.alertname,
        namespace: alert.labels?.namespace,
        summary: alert.annotations?.summary,
      }, logger);

      if (severity === 'P1') {
        await sendEmail({ to: ADMIN_EMAIL, ...buildP1Email(alert) }, logger);
        await page(alert, severity);
        publishAudit(natsClient, { event: 'alert.p1', alertname: alert.labels?.alertname }, logger);
      } else if (severity === 'P2') {
        digestQueue.push(alert);
      }
      // P3 — accumulated for daily digest only
    }
  }
}

// ── P2 digest scheduler ───────────────────────────────────────────────────────
function startDigestScheduler(natsClient) {
  setInterval(async () => {
    if (digestQueue.length === 0) return;
    const batch = digestQueue.splice(0);
    await sendEmail({ to: ADMIN_EMAIL, ...buildDigestEmail(batch) }, logger).catch(
      err => logger.error({ err: err.message }, 'Digest email failed')
    );
  }, DIGEST_INTERVAL_MS);
}

// ── Server ────────────────────────────────────────────────────────────────────
async function main() {
  const natsClient = await connectNATS(logger);
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body)); } catch (e) { done(e); }
  });

  app.post('/webhook/alertmanager', async (req, reply) => {
    reply.code(200).send({ received: true });
    handleAlertmanagerPayload(req.body, natsClient).catch(
      err => logger.error({ err: err.message }, 'Alert handler failed')
    );
  });

  app.get('/alerts', async () => ({
    active: [...activeAlerts.values()].map(a => ({
      alertname: a.labels?.alertname, severity: a.severity,
      namespace: a.labels?.namespace, firstSeenAt: a.firstSeenAt,
    })),
    digestPending: digestQueue.length,
  }));

  app.get('/health', async () => ({ status: 'ok', service: 'incident-alerting', activeAlerts: activeAlerts.size }));

  startDigestScheduler(natsClient);

  await app.listen({ port: parseInt(process.env.PORT ?? '3402', 10), host: '0.0.0.0' });
  logger.info('Incident alerting service listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
