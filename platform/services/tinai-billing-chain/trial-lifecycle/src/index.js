// trial-lifecycle/src/index.js
// Service: Trial Lifecycle Manager
//
// Runs as a K8s CronJob every 6 hours.
// Reads all tenants from PostgreSQL, checks trial status,
// and drives the full expiry → suspend → delete lifecycle.
//
// Timeline:
//   Day 0:  Trial starts (signup)
//   Day 7:  Warning email (7 days left)
//   Day 13: Urgent email (1 day left)
//   Day 14: Trial ends → namespace scaled to 0, warning email
//   Day 25: Data deletion warning (5 days until delete)
//   Day 30: Namespace + all data deleted
//
// Run: node src/index.js (then process exits — CronJob pattern)

import pino from 'pino';
import { config } from '../../shared/config.js';
import { connectNATS, publish, publishToDLQ, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { suspendNamespace, deleteNamespace, tenantToNamespace } from '../../shared/k8s-namespace.js';
import { trialEmails } from '../../invoice-generator/src/email-templates.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

// ── Mock tenant DB (replace with real postgres.js queries) ────────────────────
// In production, replace with:
//   import postgres from 'postgres';
//   const db = postgres(config.postgres.url);
//   const tenants = await db`SELECT * FROM tenants WHERE plan = 'trial' AND deleted_at IS NULL`;

async function fetchTrialTenants() {
  // TODO: replace with real DB query
  // Returns array of: { id, email, name, trial_started_at, plan, namespace_suspended, deleted_at }
  logger.warn('fetchTrialTenants: using stub — implement PostgreSQL query');
  return [];
}

async function updateTenantState(tenantId, patch) {
  // TODO: replace with real DB update
  // await db`UPDATE tenants SET ${db(patch)} WHERE external_id = ${tenantId}`;
  logger.debug({ tenantId, patch }, 'updateTenantState: stub');
}

// ── Lifecycle runner ──────────────────────────────────────────────────────────

async function processTrialTenant(tenant, natsClient) {
  const now = Date.now();
  const trialStart = new Date(tenant.trial_started_at).getTime();
  const daysSinceStart = (now - trialStart) / (1000 * 60 * 60 * 24);
  const namespace = tenantToNamespace(tenant.id, config.k8s.tenantNsPrefix);

  logger.debug({ tenantId: tenant.id, daysSinceStart: daysSinceStart.toFixed(1) }, 'Checking trial tenant');

  // ── Day 30+: Delete namespace ────────────────────────────────────────────
  if (daysSinceStart >= 30 && !tenant.deleted_at) {
    try {
      await deleteNamespace(namespace, logger);
      await updateTenantState(tenant.id, { deleted_at: new Date().toISOString() });
      publish(natsClient, config.nats.subjects.trialExpired, {
        tenantId: tenant.id, action: 'deleted', daysSinceStart: Math.floor(daysSinceStart),
        timestamp: new Date().toISOString(),
      }, logger);
      publishAudit(natsClient, { event: 'trial.namespace.deleted', tenantId: tenant.id }, logger);
      logger.info({ tenantId: tenant.id }, 'Trial namespace deleted');
    } catch (err) {
      logger.error({ err: err.message, tenantId: tenant.id }, 'Namespace deletion failed');
      await publishToDLQ(natsClient, { tenantId: tenant.id, action: 'delete' }, err, 'trial-lifecycle', logger);
    }
    return;
  }

  // ── Day 25–29: Data deletion warning ────────────────────────────────────
  if (daysSinceStart >= 25 && !tenant.day25_email_sent) {
    await sendEmail({ to: tenant.email, ...trialEmails.day25DataWarning(tenant) }, logger);
    await updateTenantState(tenant.id, { day25_email_sent: true });
    logger.info({ tenantId: tenant.id }, 'Day-25 deletion warning sent');
    return;
  }

  // ── Day 14+: Suspend namespace ───────────────────────────────────────────
  if (daysSinceStart >= 14 && !tenant.namespace_suspended) {
    try {
      await suspendNamespace(namespace, logger);
      await updateTenantState(tenant.id, { namespace_suspended: true, suspended_at: new Date().toISOString() });
      await sendEmail({ to: tenant.email, ...trialEmails.dayOfExpiry(tenant) }, logger);
      publish(natsClient, config.nats.subjects.namespaceSuspended, {
        tenantId: tenant.id, namespace, reason: 'trial_expired',
        timestamp: new Date().toISOString(),
      }, logger);
      publishAudit(natsClient, { event: 'trial.namespace.suspended', tenantId: tenant.id }, logger);
      logger.info({ tenantId: tenant.id }, 'Trial expired — namespace suspended');
    } catch (err) {
      logger.error({ err: err.message, tenantId: tenant.id }, 'Namespace suspension failed');
      await publishToDLQ(natsClient, { tenantId: tenant.id, action: 'suspend' }, err, 'trial-lifecycle', logger);
    }
    return;
  }

  // ── Day 13: Urgent warning (1 day left) ──────────────────────────────────
  if (daysSinceStart >= 13 && daysSinceStart < 14 && !tenant.day13_email_sent) {
    await sendEmail({ to: tenant.email, ...trialEmails.day7Warning(tenant, 1) }, logger);
    await updateTenantState(tenant.id, { day13_email_sent: true });
    logger.info({ tenantId: tenant.id }, 'Day-13 urgent warning sent');
    return;
  }

  // ── Day 7: First warning (7 days left) ───────────────────────────────────
  if (daysSinceStart >= 7 && daysSinceStart < 8 && !tenant.day7_email_sent) {
    await sendEmail({ to: tenant.email, ...trialEmails.day7Warning(tenant, 7) }, logger);
    await updateTenantState(tenant.id, { day7_email_sent: true });
    logger.info({ tenantId: tenant.id }, 'Day-7 warning sent');
    return;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('Trial lifecycle run starting');
  const startedAt = Date.now();

  const natsClient = await connectNATS(logger);

  const tenants = await fetchTrialTenants();
  logger.info({ count: tenants.length }, 'Trial tenants found');

  const results = await Promise.allSettled(
    tenants.map(t => processTrialTenant(t, natsClient))
  );

  const failed = results.filter(r => r.status === 'rejected').length;
  const succeeded = results.length - failed;

  const summary = {
    total: tenants.length,
    succeeded,
    failed,
    durationMs: Date.now() - startedAt,
  };

  logger.info(summary, 'Trial lifecycle run complete');

  publishAudit(natsClient, { event: 'trial.lifecycle.run', ...summary }, logger);

  // Drain NATS before exit (CronJob pattern)
  if (natsClient) {
    await natsClient.drain();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
