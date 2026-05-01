// security/audit-log-export/index.js
// Service: Audit Log Export (CronJob - daily)
//
// Exports K8s API server audit logs to MinIO.
// Produces daily compliance-ready NDJSON files.
// Extracted from egress-anomaly/index.js so the CronJob runs the correct entry point.

import pino from 'pino';
import { readFileSync } from 'fs';
import { config } from '../../shared/config.js';
import { connectNATS, publishAudit } from '../../shared/nats.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const MINIO_URL          = process.env.MINIO_URL          ?? 'http://minio.core.svc.cluster.local:9000';
const MINIO_AUDIT_BUCKET = process.env.MINIO_AUDIT_BUCKET ?? 'tinai-audit-logs';

async function exportAuditLogs() {
  logger.info('Audit log export starting');

  const yesterday = new Date(Date.now() - 86_400_000);
  const dateStr   = yesterday.toISOString().slice(0, 10);
  const auditPath = process.env.K8S_AUDIT_LOG_PATH ?? '/var/log/kubernetes/audit.log';

  try {
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

    const payload   = dayLines.join('\n');
    const objectKey = `k8s-audit/${dateStr}/audit.ndjson`;
    const uploadUrl = `${MINIO_URL}/${MINIO_AUDIT_BUCKET}/${objectKey}`;

    const accessKey = process.env.MINIO_ACCESS_KEY ?? '';
    const secretKey = process.env.MINIO_SECRET_KEY ?? '';

    await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: 'Basic ' + Buffer.from(accessKey + ':' + secretKey).toString('base64'),
      },
      body: payload,
    });

    logger.info({ dateStr, lines: dayLines.length, objectKey }, 'K8s audit logs exported to MinIO');
  } catch (err) {
    logger.warn({ err: err.message }, 'Audit log export failed (configure audit log path)');
  }
}

async function main() {
  const natsClient = await connectNATS(logger);
  await exportAuditLogs();
  if (natsClient) {
    publishAudit(natsClient, { event: 'security.audit.export', timestamp: new Date().toISOString() }, logger);
    await natsClient.drain();
  }
  process.exit(0);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
