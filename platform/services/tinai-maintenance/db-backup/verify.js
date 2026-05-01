// db-backup/verify.js
// Weekly backup restore verification.
// Restores the latest backup to a temp namespace and verifies DB connectivity.
// This is the ONLY way to know your backups actually work.
//
// CronJob: Sunday 03:00 UTC
// Requires a separate "restore-test" PostgreSQL pod in a `backup-verify` namespace.

import { spawnSync } from 'child_process';
import pino from 'pino';
import { config } from '../shared/config.js';
import { connectNATS, publish, publishAudit } from '../shared/nats.js';
import { sendEmail } from '../shared/mailer.js';

const logger = pino({ level: config.service.logLevel });

const STANZA          = process.env.PGBACKREST_STANZA   ?? 'tinai-pg';
const VERIFY_POD      = process.env.VERIFY_POD_NAME     ?? 'pg-restore-test';
const VERIFY_NS       = process.env.VERIFY_NAMESPACE     ?? 'backup-verify';
const VERIFY_HOST     = process.env.VERIFY_PG_HOST       ?? `pg-restore-test.${VERIFY_NS}.svc.cluster.local`;
const VERIFY_PASSWORD = process.env.VERIFY_PG_PASSWORD   ?? '';

function kubectlExec(pod, ns, cmd, timeout = 600_000) {
  try {
    const result = spawnSync(
      'kubectl', ['exec', pod, '-n', ns, '--', 'bash', '-c', cmd],
      { timeout, encoding: 'utf-8' }
    );
    if (result.status !== 0) {
      return { success: false, output: '', error: result.stderr?.trim() ?? '' };
    }
    return { success: true, output: result.stdout?.trim() ?? '' };
  } catch (err) {
    return { success: false, output: '', error: err.message };
  }
}

async function main() {
  const startedAt = Date.now();
  logger.info({ stanza: STANZA }, 'Backup verify starting');
  const natsClient = await connectNATS(logger);
  const adminEmail = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;

  let success = false;
  let errorMsg = null;
  let restoredTo = null;
  let tableCount = null;

  try {
    // 1. Restore to verify pod
    const restoreCmd = `pgbackrest --stanza=${STANZA} --delta restore`;
    const restore = kubectlExec(VERIFY_POD, VERIFY_NS, restoreCmd, 900_000); // 15 min
    if (!restore.success) throw new Error(`Restore failed: ${restore.error}`);
    restoredTo = VERIFY_HOST;
    logger.info({ restoredTo }, 'Restore complete');

    // 2. Start PostgreSQL on verify pod
    const startPg = kubectlExec(VERIFY_POD, VERIFY_NS, 'pg_ctl start -D /var/lib/postgresql/data -l /tmp/pg.log');
    if (!startPg.success) throw new Error(`pg_ctl start failed: ${startPg.error}`);

    // 3. Wait for PG to be ready (simple poll)
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const ping = kubectlExec(VERIFY_POD, VERIFY_NS, 'pg_isready -U postgres', 5000);
      if (ping.success && ping.output.includes('accepting')) { ready = true; break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!ready) throw new Error('PostgreSQL did not become ready after restore');

    // 4. Verify key tables exist and are queryable
    const tableCheck = kubectlExec(
      VERIFY_POD, VERIFY_NS,
      `psql -U postgres -d tinai -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'"`,
      30_000
    );
    if (!tableCheck.success) throw new Error(`Table check failed: ${tableCheck.error}`);
    tableCount = parseInt(tableCheck.output.trim(), 10);
    if (tableCount < 5) throw new Error(`Suspiciously few tables: ${tableCount} (expected ≥5)`);

    // 5. Check row counts on critical tables
    const rowCheck = kubectlExec(
      VERIFY_POD, VERIFY_NS,
      `psql -U postgres -d tinai -t -c "SELECT COUNT(*) FROM tenants"`,
      10_000
    );
    if (!rowCheck.success) throw new Error(`Row check failed: ${rowCheck.error}`);

    // 6. Stop PG on verify pod (clean up)
    kubectlExec(VERIFY_POD, VERIFY_NS, 'pg_ctl stop -D /var/lib/postgresql/data');

    success = true;
    logger.info({ tableCount, durationMs: Date.now() - startedAt }, 'Backup verify passed');

  } catch (err) {
    errorMsg = err.message;
    logger.error({ err: errorMsg }, 'Backup verify FAILED');
    // Try to stop PG even on failure
    kubectlExec(VERIFY_POD, VERIFY_NS, 'pg_ctl stop -D /var/lib/postgresql/data || true');
  }

  const durationMs = Date.now() - startedAt;

  await sendEmail({
    to: adminEmail,
    subject: `${success ? '✓' : '✗ FAILED'} Weekly backup verify — ${tableCount ?? '?'} tables restored · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid ${success ? '#86efac' : '#fca5a5'};padding:28px">
  <p style="font-size:18px;font-weight:600;color:${success ? '#16a34a' : '#dc2626'};margin:0 0 16px">
    ${success ? 'Weekly Backup Verify: PASSED' : 'Weekly Backup Verify: FAILED'}
  </p>
  <div style="background:#f8fafc;border-radius:6px;padding:14px 18px;font-size:13px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="color:#64748b;padding:3px 0">Stanza</td><td style="text-align:right">${STANZA}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Tables verified</td><td style="text-align:right">${tableCount ?? 'N/A'}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Duration</td><td style="text-align:right">${(durationMs/1000).toFixed(0)}s</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Restored to</td><td style="text-align:right">${restoredTo ?? 'N/A'}</td></tr>
    </table>
  </div>
  ${errorMsg ? `<p style="color:#dc2626;font-size:13px;background:#fef2f2;padding:12px;border-radius:6px;margin-top:16px">${errorMsg}</p>` : ''}
  <p style="color:#64748b;font-size:12px;margin-top:16px">Weekly verification ensures backup integrity. Restore tested in namespace: ${VERIFY_NS}</p>
</div></body></html>`,
  }, logger);

  publish(natsClient, 'tinai.maintenance.backup.verify', {
    timestamp: new Date().toISOString(), success, tableCount, durationMs, error: errorMsg,
  }, logger);
  publishAudit(natsClient, { event: 'db.backup.verify', success, stanza: STANZA }, logger);

  if (natsClient) await natsClient.drain();
  process.exit(success ? 0 : 1);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
