// security/egress-anomaly/index.js
// Service: Egress Anomaly Detection + Audit Log Export
//
// Egress anomaly (Deployment - polls every 5 min):
//   Watches per-namespace egress via Prometheus.
//   Detects: sudden spikes (>5x baseline), unusually high absolute egress.
//   Actions: alert admin, optionally quarantine namespace.
//
// Audit log export (CronJob - daily):
//   Exports K8s API server audit logs + pgAudit DB logs to MinIO.
//   Produces daily compliance-ready NDJSON files.

import Fastify from 'fastify';
import pino from 'pino';
import { config } from '../../shared/config.js';
import { connectNATS, publish, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { listNamespaces, k8sPatch } from '../../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const ADMIN_EMAIL          = process.env.ADMIN_EMAIL          ?? config.stalwart.fromAddr;
const PROM_URL             = process.env.PROMETHEUS_URL       ?? 'http://prometheus-server.monitoring.svc.cluster.local:9090';
const SPIKE_MULTIPLIER     = parseFloat(process.env.EGRESS_SPIKE_MULTIPLIER ?? '5');
const ABSOLUTE_ALERT_BYTES = parseInt(process.env.EGRESS_ALERT_BYTES ?? String(10 * 1024 ** 3), 10); // 10 GB
const AUTO_QUARANTINE      = process.env.AUTO_QUARANTINE === 'true';
const TENANT_PREFIX        = process.env.TENANT_NS_PREFIX ?? 'tenant-';
const POLL_INTERVAL_MS     = parseInt(process.env.POLL_INTERVAL_MS ?? String(5 * 60 * 1000), 10);
const MINIO_URL            = process.env.MINIO_URL            ?? 'http://minio.core.svc.cluster.local:9000';
const MINIO_AUDIT_BUCKET   = process.env.MINIO_AUDIT_BUCKET   ?? 'tinai-audit-logs';

// ── Egress baseline tracker ───────────────────────────────────────────────────
const egressBaseline = new Map(); // namespace → rolling avg bytes/5min
const alertsSent     = new Map(); // namespace → last alert ts

async function promQuery(query) {
  const url = new URL('/api/v1/query', PROM_URL);
  url.searchParams.set('query', query);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Prometheus query failed: ${res.status}`);
  const body = await res.json();
  return body.data?.result ?? [];
}

async function getNamespaceEgress(namespace, windowSecs = 300) {
  const results = await promQuery(
    `sum(increase(container_network_transmit_bytes_total{namespace="${namespace}"}[${windowSecs}s]))`
  );
  const val = parseFloat(results?.[0]?.value?.[1] ?? '0');
  return isNaN(val) ? 0 : Math.max(0, val);
}

function updateBaseline(namespace, currentBytes) {
  const prev = egressBaseline.get(namespace) ?? currentBytes;
  // Exponential moving average (α=0.2)
  const newAvg = 0.8 * prev + 0.2 * currentBytes;
  egressBaseline.set(namespace, newAvg);
  return newAvg;
}

async function quarantineNamespace(namespace) {
  // Apply deny-all NetworkPolicy to stop all egress
  await k8sPatch(
    `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/tenant-isolation`,
    {
      spec: {
        egress: [], // deny all egress
        ingress: [],
      },
    }
  );
  logger.warn({ namespace }, 'Namespace quarantined — all egress blocked');
}

async function checkEgressAnomalies(natsClient) {
  const namespaces = await listNamespaces();
  const tenantNS   = namespaces.map(n => n.metadata.name).filter(n => n.startsWith(TENANT_PREFIX));

  for (const ns of tenantNS) {
    try {
      const currentBytes = await getNamespaceEgress(ns, 300);
      const baseline     = updateBaseline(ns, currentBytes);
      const isSpike      = baseline > 1_000_000 && currentBytes > baseline * SPIKE_MULTIPLIER;
      const isAbsolute   = currentBytes > ABSOLUTE_ALERT_BYTES;

      if (isSpike || isAbsolute) {
        const lastAlert = alertsSent.get(ns) ?? 0;
        if (Date.now() - lastAlert < 60 * 60 * 1000) continue; // suppress hourly

        const reason = isSpike
          ? `Egress spike: ${(currentBytes / 1024**2).toFixed(1)} MB vs ${(baseline / 1024**2).toFixed(1)} MB baseline (${(currentBytes/baseline).toFixed(1)}x)`
          : `High egress: ${(currentBytes / 1024**3).toFixed(2)} GB in 5 min`;

        logger.warn({ namespace: ns, reason, currentBytes, baseline }, 'Egress anomaly detected');
        alertsSent.set(ns, Date.now());

        // Alert
        await sendEmail({
          to: ADMIN_EMAIL,
          subject: `⚠ Egress anomaly: ${ns} — ${reason} · Tinai`,
          html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #fca5a5;padding:28px">
  <p style="font-size:16px;font-weight:600;color:#dc2626;margin:0 0 12px">Egress Anomaly Detected</p>
  <div style="background:#fef2f2;border-radius:6px;padding:14px 18px;font-size:13px;margin-bottom:16px">
    <p style="margin:0 0 4px"><strong>Namespace:</strong> ${ns}</p>
    <p style="margin:0 0 4px"><strong>Current egress (5 min):</strong> ${(currentBytes / 1024**2).toFixed(1)} MB</p>
    <p style="margin:0 0 4px"><strong>Baseline:</strong> ${(baseline / 1024**2).toFixed(1)} MB</p>
    <p style="margin:0"><strong>Reason:</strong> ${reason}</p>
  </div>
  ${AUTO_QUARANTINE ? `<p style="color:#dc2626;font-size:13px;font-weight:600">Namespace has been automatically quarantined (all egress blocked).</p>` : `<p style="color:#444;font-size:13px">Consider quarantining: <code>kubectl patch networkpolicy tenant-isolation -n ${ns} --type=merge -p '{"spec":{"egress":[]}}'</code></p>`}
  <p style="color:#64748b;font-size:12px;margin-top:16px">Possible causes: data exfiltration, cryptominer, misconfigured app, or legitimate traffic spike.</p>
</div></body></html>`,
        }, logger);

        if (AUTO_QUARANTINE) await quarantineNamespace(ns);

        publish(natsClient, 'tinai.security.egress.anomaly', {
          timestamp: new Date().toISOString(), namespace: ns,
          currentBytes, baseline, reason, quarantined: AUTO_QUARANTINE,
        }, logger);
        publishAudit(natsClient, { event: 'security.egress.anomaly', namespace: ns, reason }, logger);
      }
    } catch (err) {
      logger.debug({ namespace: ns, err: err.message }, 'Egress check failed');
    }
  }
}

// ── Audit log export ──────────────────────────────────────────────────────────
async function exportAuditLogs() {
  logger.info('Audit log export starting');

  // K8s audit logs are typically written to a file on control-plane nodes.
  // In K3s, configure --audit-log-path and read via hostPath volume or node exec.
  // This stub reads from a known path and uploads to MinIO.

  const yesterday  = new Date(Date.now() - 86_400_000);
  const dateStr    = yesterday.toISOString().slice(0, 10);
  const auditPath  = process.env.K8S_AUDIT_LOG_PATH ?? '/var/log/kubernetes/audit.log';

  try {
    const { readFileSync } = await import('fs');
    const content  = readFileSync(auditPath, 'utf-8');
    const lines    = content.split('\n').filter(Boolean);

    // Filter for previous day's entries
    const dayLines = lines.filter(l => {
      try { return JSON.parse(l).stageTimestamp?.startsWith(dateStr); }
      catch { return false; }
    });

    if (dayLines.length === 0) {
      logger.info({ dateStr }, 'No audit logs for date');
      return;
    }

    const payload    = dayLines.join('\n');
    const objectKey  = `k8s-audit/${dateStr}/audit.ndjson`;
    const uploadUrl  = `${MINIO_URL}/${MINIO_AUDIT_BUCKET}/${objectKey}`;

    // PUT to MinIO (stub auth — replace with AWS SDK)
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-ndjson', Authorization: 'Basic ' + Buffer.from((process.env.MINIO_ACCESS_KEY ?? '') + ':' + (process.env.MINIO_SECRET_KEY ?? '')).toString('base64') },
      body: payload,
    });

    logger.info({ dateStr, lines: dayLines.length, objectKey }, 'K8s audit logs exported to MinIO');
  } catch (err) {
    logger.warn({ err: err.message }, 'Audit log export failed (stub — configure audit log path)');
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const runMode    = process.env.RUN_MODE ?? 'monitor'; // 'monitor' | 'audit-export'
  const natsClient = await connectNATS(logger);

  if (runMode === 'audit-export') {
    await exportAuditLogs();
    if (natsClient) await natsClient.drain();
    process.exit(0);
    return;
  }

  // Monitor mode — long-running Deployment
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({
    status: 'ok', service: 'egress-anomaly',
    trackedNamespaces: egressBaseline.size,
    activeAlerts: [...alertsSent.entries()].filter(([,ts]) => Date.now() - ts < 3_600_000).length,
  }));
  await app.listen({ port: parseInt(process.env.PORT ?? '3500', 10), host: '0.0.0.0' });
  logger.info({ pollIntervalMs: POLL_INTERVAL_MS, autoQuarantine: AUTO_QUARANTINE }, 'Egress anomaly monitor started');

  await checkEgressAnomalies(natsClient);
  setInterval(() => checkEgressAnomalies(natsClient), POLL_INTERVAL_MS);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
