// db-backup/index.js
// Database backup orchestrator for Tinai's PostgreSQL instances.
//
// Strategy:
//   WAL archiving  — continuous, via pgBackRest sidecar (always running)
//   Base backup    — daily full backup via this CronJob
//   Verify         — weekly restore test via separate verify CronJob
//
// This script:
//   1. Triggers pgBackRest stanza-backup via kubectl exec into the postgres pod
//   2. Verifies backup completed successfully (checks pgBackRest info output)
//   3. Prunes backups older than retention policy
//   4. Sends backup report email
//   5. Publishes backup status to NATS
//
// CronJob: daily at 02:00 UTC
// pgBackRest must be configured with stanza "tinai-pg" pointing to MinIO.

import { spawnSync } from 'child_process';
import pino from 'pino';
import { config } from '../shared/config.js';
import { connectNATS, publish, publishAudit, publishToDLQ } from '../shared/nats.js';
import { sendEmail } from '../shared/mailer.js';
import { listPods } from '../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const STANZA        = process.env.PGBACKREST_STANZA ?? 'tinai-pg';
const PG_NAMESPACE  = process.env.PG_NAMESPACE      ?? 'core';
const PG_LABEL      = process.env.PG_POD_LABEL      ?? 'app=postgresql,role=primary';
const RETENTION_FULL = parseInt(process.env.BACKUP_RETENTION_FULL  ?? '7',  10); // keep 7 full backups
const RETENTION_DIFF = parseInt(process.env.BACKUP_RETENTION_DIFF  ?? '14', 10); // keep 14 diff backups

// ── kubectl exec wrapper ──────────────────────────────────────────────────────
function kubectlExec(podName, namespace, command, timeoutMs = 300_000) {
  logger.debug({ cmd: command }, 'kubectl exec');
  try {
    const result = spawnSync(
      'kubectl', ['exec', podName, '-n', namespace, '-c', 'postgres', '--', 'bash', '-c', command],
      { timeout: timeoutMs, encoding: 'utf-8' }
    );
    if (result.status !== 0) {
      return { success: false, output: result.stdout?.trim() ?? '', error: result.stderr?.trim() ?? '' };
    }
    return { success: true, output: result.stdout?.trim() ?? '' };
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
}

// ── Find primary PostgreSQL pod ───────────────────────────────────────────────
async function findPrimaryPod() {
  const pods = await listPods(PG_NAMESPACE, PG_LABEL);
  const running = pods.filter(p => p.status?.phase === 'Running');
  if (running.length === 0) throw new Error(`No running PostgreSQL pods found in ${PG_NAMESPACE}`);
  return running[0].metadata.name;
}

// ── pgBackRest operations ─────────────────────────────────────────────────────
function pgBackRestBackup(podName, type = 'full') {
  return kubectlExec(
    podName, PG_NAMESPACE,
    `pgbackrest --stanza=${STANZA} --type=${type} backup`,
    10 * 60 * 1000 // 10 min timeout for full backup
  );
}

function pgBackRestInfo(podName) {
  const result = kubectlExec(podName, PG_NAMESPACE, `pgbackrest --stanza=${STANZA} --output=json info`);
  if (!result.success) return null;
  try { return JSON.parse(result.output); }
  catch { return null; }
}

function pgBackRestExpire(podName) {
  return kubectlExec(
    podName, PG_NAMESPACE,
    `pgbackrest --stanza=${STANZA} --repo1-retention-full=${RETENTION_FULL} --repo1-retention-diff=${RETENTION_DIFF} expire`
  );
}

// ── Parse backup info ─────────────────────────────────────────────────────────
function parseBackupInfo(infoJson) {
  if (!infoJson || !Array.isArray(infoJson)) return null;
  const stanza = infoJson.find(s => s.name === STANZA);
  if (!stanza) return null;

  const backups = stanza.backup ?? [];
  const latest  = backups[backups.length - 1];
  const walMin  = stanza.archive?.[0]?.min ?? null;
  const walMax  = stanza.archive?.[0]?.max ?? null;

  return {
    stanza:        stanza.name,
    status:        stanza.status?.code === 0 ? 'ok' : 'error',
    backupCount:   backups.length,
    latestType:    latest?.type ?? null,
    latestStart:   latest?.timestamp?.start ? new Date(latest.timestamp.start * 1000).toISOString() : null,
    latestStop:    latest?.timestamp?.stop  ? new Date(latest.timestamp.stop  * 1000).toISOString() : null,
    latestSizeGB:  latest?.info?.size ? (latest.info.size / (1024 ** 3)).toFixed(2) : null,
    walMin, walMax,
    durationSecs:  latest ? (latest.timestamp.stop - latest.timestamp.start) : null,
  };
}

// ── Email builder ─────────────────────────────────────────────────────────────
function buildBackupEmail(info, success, error) {
  const statusColor = success ? '#16a34a' : '#dc2626';
  const statusLabel = success ? 'Backup Successful' : 'Backup FAILED';

  return {
    subject: `${success ? '✓' : '✗'} DB backup ${success ? 'complete' : 'FAILED'} — ${new Date().toLocaleDateString('en-IN')} · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid ${success ? '#86efac' : '#fca5a5'};padding:28px">
  <p style="font-size:18px;font-weight:600;color:${statusColor};margin:0 0 20px">${statusLabel}</p>
  ${info ? `
  <div style="background:#f8fafc;border-radius:6px;padding:14px 18px;font-size:13px;margin-bottom:16px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="color:#64748b;padding:3px 0">Stanza</td><td style="text-align:right">${info.stanza}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Type</td><td style="text-align:right">${info.latestType?.toUpperCase() ?? '—'}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Started</td><td style="text-align:right">${info.latestStart ?? '—'}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Duration</td><td style="text-align:right">${info.durationSecs ? `${info.durationSecs}s` : '—'}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Size</td><td style="text-align:right">${info.latestSizeGB ? `${info.latestSizeGB} GB` : '—'}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Total backups</td><td style="text-align:right">${info.backupCount}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">WAL archived</td><td style="text-align:right">${info.walMax ?? '—'}</td></tr>
    </table>
  </div>` : ''}
  ${error ? `<p style="color:#dc2626;font-size:13px;background:#fef2f2;padding:12px;border-radius:6px">${error}</p>` : ''}
  <p style="color:#64748b;font-size:12px;margin-top:16px">
    Backups stored in MinIO (s3://tinai-backups/pgbackrest/${STANZA}/)<br>
    Retention: ${RETENTION_FULL} full, ${RETENTION_DIFF} differential backups
  </p>
</div></body></html>`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const startedAt  = Date.now();
  const backupType = process.env.BACKUP_TYPE ?? 'full'; // 'full' or 'diff'
  logger.info({ backupType, stanza: STANZA }, 'Database backup starting');

  const natsClient  = await connectNATS(logger);
  const adminEmail  = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;

  let podName, backupResult, infoResult, info;
  let success = false;
  let errorMsg = null;

  try {
    // 1. Find primary pod
    podName = await findPrimaryPod();
    logger.info({ podName }, 'Primary PostgreSQL pod found');

    // 2. Run backup
    backupResult = pgBackRestBackup(podName, backupType);
    if (!backupResult.success) throw new Error(backupResult.error ?? 'Backup command failed');

    // 3. Verify via pgbackrest info
    infoResult = pgBackRestInfo(podName);
    info = parseBackupInfo(infoResult);
    if (!info || info.status !== 'ok') throw new Error('pgBackRest info indicates error state');

    // 4. Prune old backups
    const expireResult = pgBackRestExpire(podName);
    if (!expireResult.success) {
      logger.warn({ error: expireResult.error }, 'Backup expire (pruning) failed — non-fatal');
    }

    success = true;
    logger.info({ durationMs: Date.now() - startedAt, sizeGB: info.latestSizeGB }, 'Backup complete');

  } catch (err) {
    errorMsg = err.message;
    logger.error({ err: errorMsg }, 'Backup failed');
    await publishToDLQ(natsClient, { stanza: STANZA, backupType }, err, 'db-backup', logger);
  }

  // 5. Email report
  await sendEmail({ to: adminEmail, ...buildBackupEmail(info, success, errorMsg) }, logger);

  // 6. Publish to NATS
  const payload = {
    timestamp: new Date().toISOString(),
    stanza: STANZA, backupType, success, podName,
    durationMs: Date.now() - startedAt,
    ...(info ?? {}),
    error: errorMsg,
  };
  publish(natsClient, 'tinai.maintenance.backup', payload, logger);
  publishAudit(natsClient, { event: 'db.backup', success, stanza: STANZA, backupType }, logger);

  if (natsClient) await natsClient.drain();
  process.exit(success ? 0 : 1);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
