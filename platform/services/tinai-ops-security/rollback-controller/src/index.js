// rollback-controller/src/index.js
// Service: Deployment Rollback Controller
//
// Subscribes to tinai.build.success events.
// After a successful deploy, monitors the deployment for 5 minutes.
// If health checks fail → automatic rollback + alert.
//
// Also exposes POST /rollback/:tenantId for manual rollback from dashboard.

import Fastify from 'fastify';
import crypto from 'crypto';
import pino from 'pino';
import { connect, JSONCodec } from 'nats';
import { config } from '../../shared/config.js';
import { publish, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { k8sGet, k8sPatch } from '../../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const jc = JSONCodec();
const ADMIN_EMAIL      = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;
const MONITOR_DURATION = parseInt(process.env.MONITOR_DURATION_MS ?? String(5 * 60 * 1000), 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS    ?? '15000', 10);
const TENANT_PREFIX    = process.env.TENANT_NS_PREFIX ?? 'tenant-';

// ── Rollback via K8s rollout undo ─────────────────────────────────────────────
async function triggerRollback(namespace, deployName = 'app', reason) {
  logger.warn({ namespace, deployName, reason }, 'Triggering rollback');

  // Annotate with rollback metadata
  await k8sPatch(
    `/apis/apps/v1/namespaces/${namespace}/deployments/${deployName}`,
    {
      metadata: {
        annotations: {
          'tinai.cloud/rolled-back-at':     new Date().toISOString(),
          'tinai.cloud/rollback-reason':    reason,
          'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
        },
      },
    }
  );

  // K8s doesn't expose "rollout undo" directly via REST API.
  // We achieve rollback by fetching the previous ReplicaSet and patching replicas.
  const rsData = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/replicasets?labelSelector=app=${deployName}`);
  const rsList = (rsData.items ?? [])
    .filter(rs => (rs.status?.replicas ?? 0) === 0)  // find previous (scaled down)
    .sort((a, b) => new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp));

  if (rsList.length === 0) {
    logger.warn({ namespace }, 'No previous ReplicaSet found for rollback');
    return false;
  }

  const prevRS = rsList[0];
  const prevImage = prevRS.spec?.template?.spec?.containers?.[0]?.image;

  if (prevImage) {
    // Patch deployment with previous image
    await k8sPatch(
      `/apis/apps/v1/namespaces/${namespace}/deployments/${deployName}`,
      {
        spec: {
          template: {
            spec: {
              containers: [{ name: 'app', image: prevImage }],
            },
          },
        },
      }
    );
    logger.info({ namespace, prevImage }, 'Rollback to previous image applied');
    return true;
  }

  return false;
}

// ── Monitor deployment health post-deploy ─────────────────────────────────────
async function monitorDeployment(tenantId, commitSha, buildId, nc) {
  const namespace   = `${TENANT_PREFIX}${tenantId}`;
  const deployName  = 'app';
  const deadline    = Date.now() + MONITOR_DURATION;
  let   consecutive = 0;

  logger.info({ tenantId, namespace, monitorDurationMs: MONITOR_DURATION }, 'Post-deploy monitoring started');

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const dep = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments/${deployName}`);
      const desired   = dep.spec?.replicas ?? 1;
      const available = dep.status?.availableReplicas ?? 0;
      const ready     = dep.status?.readyReplicas ?? 0;

      if (available >= desired && ready >= desired) {
        consecutive++;
        if (consecutive >= 3) {
          // Healthy for 3 consecutive checks (~45s) → confirmed stable
          logger.info({ tenantId, consecutive }, 'Deployment stable — monitoring complete');
          publish(nc, 'tinai.ops.deployment.stable', {
            tenantId, commitSha, buildId, timestamp: new Date().toISOString(),
          }, logger);
          return { stable: true };
        }
      } else {
        consecutive = 0; // reset

        // Check for crash conditions
        const conditions = dep.status?.conditions ?? [];
        const progressing = conditions.find(c => c.type === 'Progressing');
        if (progressing?.reason === 'ProgressDeadlineExceeded') {
          throw new Error('Deployment progress deadline exceeded');
        }
      }
    } catch (err) {
      consecutive = 0;
      logger.warn({ err: err.message, tenantId }, 'Health check error');
    }
  }

  // Monitoring timeout — deployment didn't stabilize
  const reason = `Deployment did not stabilize within ${MONITOR_DURATION / 60000} minutes`;
  logger.error({ tenantId, reason }, 'Deployment unstable — triggering rollback');

  const rolledBack = await triggerRollback(namespace, deployName, reason);

  // Alert
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `✗ Auto-rollback triggered: ${tenantId}@${commitSha?.slice(0,7)} · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #fca5a5;padding:28px">
  <p style="font-size:16px;font-weight:600;color:#dc2626;margin:0 0 12px">Auto-rollback triggered</p>
  <div style="background:#fef2f2;border-radius:6px;padding:14px 18px;font-size:13px">
    <p style="margin:2px 0"><strong>Tenant:</strong> ${tenantId}</p>
    <p style="margin:2px 0"><strong>Commit:</strong> ${commitSha?.slice(0,7)}</p>
    <p style="margin:2px 0"><strong>Reason:</strong> ${reason}</p>
    <p style="margin:2px 0"><strong>Rolled back:</strong> ${rolledBack ? 'Yes — previous version restored' : 'Failed — manual intervention required'}</p>
  </div>
  <p style="color:#64748b;font-size:12px;margin-top:16px">Check pod logs: <code>kubectl logs -n ${namespace} -l app=app --previous</code></p>
</div></body></html>`,
  }, logger);

  publish(nc, 'tinai.ops.deployment.rollback', {
    tenantId, commitSha, buildId, reason, rolledBack, timestamp: new Date().toISOString(),
  }, logger);
  publishAudit(nc, { event: 'deploy.rollback', tenantId, reason, rolledBack }, logger);

  return { stable: false, rolledBack, reason };
}

// ── Server ────────────────────────────────────────────────────────────────────
async function main() {
  const nc  = await connect({ servers: config.nats.servers, reconnect: true, maxReconnectAttempts: -1 });
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body)); } catch (e) { done(e); }
  });

  // Subscribe to successful build events
  const sub = nc.subscribe('tinai.build.success');
  (async () => {
    for await (const msg of sub) {
      try {
        const { tenantId, commitSha, buildId } = jc.decode(msg.data);
        // Run monitoring asynchronously — don't block
        monitorDeployment(tenantId, commitSha, buildId, nc)
          .catch(err => logger.error({ tenantId, err: err.message }, 'Monitor error'));
      } catch (err) {
        logger.error({ err: err.message }, 'Rollback controller event error');
      }
    }
  })();

  // Manual rollback API
  app.post('/rollback/:tenantId', async (req, reply) => {
    const token = req.headers['x-admin-token'] ?? '';
    const expected = config.service.adminToken;
    if (!token || !expected || token.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const { tenantId } = req.params;
    const namespace    = `${TENANT_PREFIX}${tenantId}`;
    const result = await triggerRollback(namespace, 'app', 'manual rollback via API');
    return reply.send({ success: result, tenantId });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'rollback-controller' }));

  await app.listen({ port: parseInt(process.env.PORT ?? '3405', 10), host: '0.0.0.0' });
  logger.info('Rollback controller listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
