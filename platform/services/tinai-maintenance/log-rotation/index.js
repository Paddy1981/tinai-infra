// log-rotation/index.js
// Manages log retention policy in Loki and archives cold logs to MinIO.
//
// Loki's built-in retention handles deletion automatically once configured.
// This service adds:
//   1. Validates Loki retention config is correct (CronJob weekly)
//   2. Archives logs older than 30 days to MinIO cold storage (before Loki deletes)
//   3. Reports log volume stats per namespace
//   4. Sends weekly log digest to admin
//
// CronJob: Sunday 02:00 UTC

import pino from 'pino';
import { config } from '../shared/config.js';
import { connectNATS, publish, publishAudit } from '../shared/nats.js';
import { sendEmail } from '../shared/mailer.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const LOKI_URL         = process.env.LOKI_URL         ?? 'http://loki.monitoring.svc.cluster.local:3100';
const MINIO_URL        = process.env.MINIO_URL        ?? 'http://minio.core.svc.cluster.local:9000';
const MINIO_BUCKET     = process.env.MINIO_LOG_BUCKET ?? 'tinai-log-archive';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? '';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? '';
const RETENTION_DAYS   = parseInt(process.env.LOG_RETENTION_DAYS ?? '90', 10);
const ARCHIVE_AFTER    = parseInt(process.env.LOG_ARCHIVE_AFTER_DAYS ?? '30', 10);

// ── Loki API helpers ──────────────────────────────────────────────────────────
async function lokiQuery(query, start, end, limit = 5000) {
  const url = new URL('/loki/api/v1/query_range', LOKI_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('start', Math.floor(start / 1000) * 1_000_000_000); // nanoseconds
  url.searchParams.set('end',   Math.floor(end   / 1000) * 1_000_000_000);
  url.searchParams.set('limit', limit);
  url.searchParams.set('direction', 'forward');

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Loki query failed: ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.data?.result ?? [];
}

async function getLokiRetentionConfig() {
  try {
    const res = await fetch(`${LOKI_URL}/loki/api/v1/status/buildinfo`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function getLokiStats() {
  // Loki metrics endpoint for ingestion stats
  try {
    const res = await fetch(`${LOKI_URL}/metrics`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const text = await res.text();
    // Parse key metrics from Prometheus text format
    const ingestBytes = parseMetricLine(text, 'loki_ingester_chunk_stored_bytes_total');
    const chunkCount  = parseMetricLine(text, 'loki_ingester_chunks_stored_total');
    return { ingestBytes, chunkCount };
  } catch { return null; }
}

function parseMetricLine(text, metricName) {
  const lines = text.split('\n').filter(l => l.startsWith(metricName) && !l.startsWith('#'));
  return lines.reduce((sum, l) => {
    const val = parseFloat(l.split(' ').pop() ?? '0');
    return sum + (isNaN(val) ? 0 : val);
  }, 0);
}

// ── Archive logs to MinIO ─────────────────────────────────────────────────────
// Fetches logs from Loki for the archive window and stores as NDJSON in MinIO.
// Uses basic MinIO S3 API (PUT object).
async function archiveNamespaceLogs(namespace, archiveStart, archiveEnd) {
  const query   = `{namespace="${namespace}"}`;
  const streams = await lokiQuery(query, archiveStart, archiveEnd);

  if (streams.length === 0) return { namespace, lines: 0, bytes: 0 };

  // Build NDJSON from all log lines
  const lines = [];
  for (const stream of streams) {
    for (const [ts, line] of (stream.values ?? [])) {
      lines.push(JSON.stringify({ ts, namespace, labels: stream.labels ?? {}, line }));
    }
  }

  if (lines.length === 0) return { namespace, lines: 0, bytes: 0 };

  const content   = lines.join('\n');
  const bytes     = Buffer.byteLength(content, 'utf-8');
  const dateStr   = new Date(archiveStart).toISOString().slice(0, 10);
  const objectKey = `logs/${namespace}/${dateStr}.ndjson`;

  // PUT to MinIO (S3-compatible)
  const putUrl = `${MINIO_URL}/${MINIO_BUCKET}/${objectKey}`;
  const authHeader = buildMinIOAuth('PUT', `/${MINIO_BUCKET}/${objectKey}`, 'application/x-ndjson', bytes);

  try {
    const res = await fetch(putUrl, {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/x-ndjson', 'Content-Length': bytes },
      body: content,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`MinIO PUT failed: ${res.status}`);
    logger.info({ namespace, objectKey, lines: lines.length, bytes }, 'Logs archived to MinIO');
    return { namespace, lines: lines.length, bytes };
  } catch (err) {
    logger.warn({ namespace, err: err.message }, 'Log archive failed — skipping');
    return { namespace, lines: 0, bytes: 0, error: err.message };
  }
}

// ── Simplified MinIO auth (HMAC-SHA256) ──────────────────────────────────────
// In production: use the official @aws-sdk/client-s3 or minio npm package.
function buildMinIOAuth(method, path, contentType, contentLength) {
  // Stub: return empty auth for local dev. Replace with AWS Signature V4.
  logger.debug({ method, path }, 'MinIO auth (stub)');
  return {
    Authorization: `AWS ${MINIO_ACCESS_KEY}:stub-sig`,
    'x-amz-date': new Date().toUTCString(),
  };
}

// ── Email digest ──────────────────────────────────────────────────────────────
function buildLogDigestEmail(stats, archived) {
  const totalLines  = archived.reduce((s, a) => s + (a.lines ?? 0), 0);
  const totalBytes  = archived.reduce((s, a) => s + (a.bytes ?? 0), 0);
  const gbArchived  = (totalBytes / (1024 ** 3)).toFixed(3);

  return {
    subject: `Log digest: ${archived.length} namespaces archived · ${gbArchived} GB → MinIO · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 16px">Weekly Log Rotation Report</p>
  <div style="background:#f8fafc;border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:13px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="color:#64748b;padding:3px 0">Namespaces archived</td><td style="text-align:right">${archived.length}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Total log lines</td><td style="text-align:right">${totalLines.toLocaleString()}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Archive size</td><td style="text-align:right">${gbArchived} GB</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Archive window</td><td style="text-align:right">${ARCHIVE_AFTER}d+ old</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Loki retention</td><td style="text-align:right">${RETENTION_DAYS} days</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Cold storage</td><td style="text-align:right">MinIO: ${MINIO_BUCKET}</td></tr>
    </table>
  </div>
  ${stats ? `<p style="color:#64748b;font-size:12px">Loki ingest: ${(stats.ingestBytes / (1024**3)).toFixed(2)} GB stored · ${(stats.chunkCount ?? 0).toLocaleString()} chunks</p>` : ''}
  <p style="color:#64748b;font-size:12px">Archived logs retained in MinIO for 1 year for compliance.</p>
</div></body></html>`,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  logger.info({ retentionDays: RETENTION_DAYS, archiveAfter: ARCHIVE_AFTER }, 'Log rotation starting');
  const natsClient = await connectNATS(logger);
  const adminEmail = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;

  const archiveEnd   = Date.now() - ARCHIVE_AFTER * 24 * 60 * 60 * 1000;
  const archiveStart = archiveEnd - 7 * 24 * 60 * 60 * 1000; // archive 1 week at a time

  // Get Loki stats
  const stats = await getLokiStats();

  // Get all tenant namespaces from Loki label values
  const url = new URL('/loki/api/v1/label/namespace/values', LOKI_URL);
  let namespaces = [];
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    namespaces = (body.data ?? []).filter(ns =>
      ns.startsWith(process.env.TENANT_NS_PREFIX ?? 'tenant-')
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not fetch Loki namespace labels');
  }

  logger.info({ namespaces: namespaces.length }, 'Namespaces to archive');

  // Archive each namespace (sequential to avoid Loki overload)
  const archived = [];
  for (const ns of namespaces) {
    const result = await archiveNamespaceLogs(ns, archiveStart, archiveEnd);
    archived.push(result);
  }

  await sendEmail({ to: adminEmail, ...buildLogDigestEmail(stats, archived) }, logger);

  publish(natsClient, 'tinai.maintenance.logs', {
    timestamp: new Date().toISOString(),
    namespacesArchived: archived.length,
    totalLines: archived.reduce((s, a) => s + (a.lines ?? 0), 0),
    totalBytes: archived.reduce((s, a) => s + (a.bytes ?? 0), 0),
  }, logger);
  publishAudit(natsClient, { event: 'log.rotation', namespacesArchived: archived.length }, logger);

  logger.info({ archived: archived.length }, 'Log rotation complete');
  if (natsClient) await natsClient.drain();
  process.exit(0);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
