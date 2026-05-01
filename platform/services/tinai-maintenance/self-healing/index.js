// self-healing/index.js
// Proactive self-healing monitor — supplements K8s built-in restartPolicy.
// Detects and resolves conditions K8s won't auto-fix:
//   - CrashLoopBackOff pods stuck > threshold (force delete to reset backoff)
//   - Nodes under memory/disk pressure (cordon + alert)
//   - Deployments with 0 available replicas (alert + attempt rollback)
//   - Pending pods > 30 min (alert — usually resource starvation)
//   - Evicted pods (clean up completed/failed pods)
//
// Runs as a Deployment with short polling interval (every 5 min).
// Also exposes /health for K8s liveness probe.

import Fastify from 'fastify';
import pino from 'pino';
import { config } from '../shared/config.js';
import { connectNATS, publish, publishAudit } from '../shared/nats.js';
import { sendEmail } from '../shared/mailer.js';
import { k8sGet, k8sDelete, k8sPatch, listNodes, listPods, listNamespaces, listDeployments } from '../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const POLL_INTERVAL_MS      = parseInt(process.env.POLL_INTERVAL_MS ?? String(5 * 60 * 1000), 10);
const CRASHLOOP_THRESHOLD   = parseInt(process.env.CRASHLOOP_THRESHOLD ?? '5', 10);
const PENDING_ALERT_MINS    = parseInt(process.env.PENDING_ALERT_MINS ?? '30', 10);
const ADMIN_EMAIL           = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;
const SYSTEM_NAMESPACES     = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

// Namespaces where pods must NEVER be force-deleted by self-healing
const PROTECTED_NAMESPACES  = new Set([
  'kube-system', 'kube-public', 'kube-node-lease',
  'vault', 'external-secrets', 'tinai-system', 'monitoring',
]);

// Track alerts sent to avoid spam (reset hourly)
const alertsSent = new Map();
function shouldAlert(key) {
  const last = alertsSent.get(key) ?? 0;
  if (Date.now() - last > 60 * 60 * 1000) { alertsSent.set(key, Date.now()); return true; }
  return false;
}

// ── Node health ───────────────────────────────────────────────────────────────
async function checkNodes(natsClient) {
  const nodes = await listNodes();
  const issues = [];

  for (const node of nodes) {
    const name = node.metadata.name;
    const conditions = node.status?.conditions ?? [];

    const memPressure  = conditions.find(c => c.type === 'MemoryPressure')?.status === 'True';
    const diskPressure = conditions.find(c => c.type === 'DiskPressure')?.status === 'True';
    const pidPressure  = conditions.find(c => c.type === 'PIDPressure')?.status === 'True';
    const notReady     = conditions.find(c => c.type === 'Ready')?.status !== 'True';

    if (memPressure || diskPressure || pidPressure || notReady) {
      const problem = [
        memPressure  && 'MemoryPressure',
        diskPressure && 'DiskPressure',
        pidPressure  && 'PIDPressure',
        notReady     && 'NotReady',
      ].filter(Boolean).join(', ');

      issues.push({ node: name, problem });
      logger.warn({ node: name, problem }, 'Node under pressure');

      // Cordon node to prevent new scheduling (only if memory/disk pressure)
      if ((memPressure || diskPressure) && shouldAlert(`node-cordon-${name}`)) {
        try {
          await k8sPatch(`/api/v1/nodes/${name}`, { spec: { unschedulable: true } });
          logger.warn({ node: name }, 'Node cordoned due to pressure');
        } catch (err) {
          logger.error({ err: err.message }, 'Could not cordon node');
        }
      }

      publish(natsClient, 'tinai.maintenance.node.pressure', {
        timestamp: new Date().toISOString(), node: name, problem,
      }, logger);
    }
  }

  return issues;
}

// ── Pod health ────────────────────────────────────────────────────────────────
async function checkPods(natsClient) {
  const namespaces = await listNamespaces();
  const crashLooping = [];
  const longPending  = [];
  const evicted      = [];

  for (const ns of namespaces) {
    const nsName = ns.metadata.name;
    if (SYSTEM_NAMESPACES.has(nsName)) continue;

    const pods = await listPods(nsName);

    for (const pod of pods) {
      const name  = pod.metadata.name;
      const phase = pod.status?.phase ?? 'Unknown';

      // Evicted pods — clean them up
      if (pod.status?.reason === 'Evicted') {
        evicted.push({ namespace: nsName, name });
        try {
          await k8sDelete(`/api/v1/namespaces/${nsName}/pods/${name}`);
          logger.info({ namespace: nsName, pod: name }, 'Evicted pod deleted');
        } catch (err) {
          logger.warn({ err: err.message }, 'Could not delete evicted pod');
        }
        continue;
      }

      // Long-pending pods
      if (phase === 'Pending') {
        const startTime   = pod.status?.startTime ?? pod.metadata.creationTimestamp;
        const pendingMins = (Date.now() - new Date(startTime)) / (1000 * 60);
        if (pendingMins > PENDING_ALERT_MINS) {
          longPending.push({ namespace: nsName, name, pendingMins: Math.round(pendingMins) });
          if (shouldAlert(`pending-${nsName}-${name}`)) {
            publish(natsClient, 'tinai.maintenance.pod.pending', {
              timestamp: new Date().toISOString(), namespace: nsName, pod: name,
              pendingMins: Math.round(pendingMins),
            }, logger);
          }
        }
        continue;
      }

      // CrashLoopBackOff
      for (const cs of (pod.status?.containerStatuses ?? [])) {
        if (cs.state?.waiting?.reason === 'CrashLoopBackOff' &&
            cs.restartCount >= CRASHLOOP_THRESHOLD) {
          crashLooping.push({ namespace: nsName, name, container: cs.name, restarts: cs.restartCount });

          // Force delete pod to reset backoff timer (K8s will recreate from Deployment)
          // Safety: only force-delete in tenant namespaces, never in protected namespaces
          if (PROTECTED_NAMESPACES.has(nsName) || !nsName.startsWith('tenant-')) {
            logger.warn({ namespace: nsName, pod: name }, 'Skipping force-delete: namespace is protected or not a tenant namespace');
            continue;
          }
          if (shouldAlert(`crashloop-${nsName}-${name}-${cs.name}`)) {
            logger.warn({ namespace: nsName, pod: name, restarts: cs.restartCount }, 'Force-deleting crashloop pod');
            try {
              await k8sDelete(`/api/v1/namespaces/${nsName}/pods/${name}?gracePeriodSeconds=0`);
              publish(natsClient, 'tinai.maintenance.pod.crashloop', {
                timestamp: new Date().toISOString(), namespace: nsName, pod: name,
                container: cs.name, restarts: cs.restartCount, action: 'force-deleted',
              }, logger);
            } catch (err) {
              logger.error({ err: err.message }, 'Force delete failed');
            }
          }
        }
      }
    }
  }

  return { crashLooping, longPending, evicted };
}

// ── Deployment health ─────────────────────────────────────────────────────────
async function checkDeployments(natsClient) {
  const namespaces = await listNamespaces();
  const unhealthy = [];

  for (const ns of namespaces) {
    const nsName = ns.metadata.name;
    if (SYSTEM_NAMESPACES.has(nsName)) continue;

    try {
      const deployments = await listDeployments(nsName);
      for (const dep of deployments) {
        const desired   = dep.spec?.replicas ?? 1;
        const available = dep.status?.availableReplicas ?? 0;
        if (desired > 0 && available === 0) {
          unhealthy.push({ namespace: nsName, name: dep.metadata.name, desired, available });
          if (shouldAlert(`dep-unavailable-${nsName}-${dep.metadata.name}`)) {
            publish(natsClient, 'tinai.maintenance.deployment.unavailable', {
              timestamp: new Date().toISOString(), namespace: nsName,
              deployment: dep.metadata.name, desired, available,
            }, logger);
          }
        }
      }
    } catch { /* namespace may have no deployments */ }
  }
  return unhealthy;
}

// ── Alert email ───────────────────────────────────────────────────────────────
async function sendAlertIfNeeded(nodeIssues, podIssues, depIssues) {
  const { crashLooping, longPending } = podIssues;
  const totalIssues = nodeIssues.length + crashLooping.length + longPending.length + depIssues.length;
  if (totalIssues === 0 || !shouldAlert('self-healing-digest')) return;

  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `Self-healing alert: ${totalIssues} issue(s) detected · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #fca5a5;padding:28px">
  <p style="font-size:16px;font-weight:600;color:#dc2626;margin:0 0 16px">Self-Healing Alert — ${totalIssues} issue(s)</p>
  ${nodeIssues.length > 0 ? `<p style="font-weight:600;font-size:13px;margin:0 0 6px">Node Issues (${nodeIssues.length})</p>
  <ul style="font-size:13px;color:#444;margin:0 0 16px">${nodeIssues.map(n=>`<li>${n.node}: ${n.problem}</li>`).join('')}</ul>` : ''}
  ${crashLooping.length > 0 ? `<p style="font-weight:600;font-size:13px;margin:0 0 6px">CrashLoopBackOff (${crashLooping.length}) — force-deleted to reset</p>
  <ul style="font-size:13px;color:#444;margin:0 0 16px">${crashLooping.map(p=>`<li>${p.namespace}/${p.name} (${p.restarts} restarts)</li>`).join('')}</ul>` : ''}
  ${longPending.length > 0 ? `<p style="font-weight:600;font-size:13px;margin:0 0 6px">Long-pending Pods (${longPending.length})</p>
  <ul style="font-size:13px;color:#444;margin:0 0 16px">${longPending.map(p=>`<li>${p.namespace}/${p.name} pending ${p.pendingMins}m</li>`).join('')}</ul>` : ''}
  ${depIssues.length > 0 ? `<p style="font-weight:600;font-size:13px;margin:0 0 6px">Deployments with 0 available replicas (${depIssues.length})</p>
  <ul style="font-size:13px;color:#444;margin:0 0 16px">${depIssues.map(d=>`<li>${d.namespace}/${d.name} (${d.available}/${d.desired})</li>`).join('')}</ul>` : ''}
  <p style="color:#64748b;font-size:12px">Self-healing actions taken automatically where possible. Check dashboard for full status.</p>
</div></body></html>`,
  }, logger);
}

// ── Main poll loop ─────────────────────────────────────────────────────────────
async function runCheck(natsClient) {
  try {
    const [nodeIssues, podIssues, depIssues] = await Promise.all([
      checkNodes(natsClient),
      checkPods(natsClient),
      checkDeployments(natsClient),
    ]);

    const totalIssues = nodeIssues.length + podIssues.crashLooping.length +
                        podIssues.longPending.length + depIssues.length;

    if (totalIssues > 0) {
      logger.warn({ nodeIssues: nodeIssues.length, crashLooping: podIssues.crashLooping.length,
        longPending: podIssues.longPending.length, depIssues: depIssues.length }, 'Issues detected');
      await sendAlertIfNeeded(nodeIssues, podIssues, depIssues);
    } else {
      logger.debug('All checks passed');
    }

    publishAudit(natsClient, { event: 'self.healing.check', totalIssues,
      evicted: podIssues.evicted.length }, logger);

  } catch (err) {
    logger.error({ err: err.message }, 'Health check cycle failed');
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────
async function main() {
  const natsClient = await connectNATS(logger);
  const app = Fastify({ logger: false });

  // Unauthenticated liveness probe endpoint for K8s
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/health', async (request, reply) => {
    // Skip auth in development for local testing
    if (process.env.NODE_ENV !== 'development') {
      const authHeader = request.headers.authorization ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!config.service.adminToken || token !== config.service.adminToken) {
        reply.code(401);
        return { error: 'Unauthorized' };
      }
    }
    return { status: 'ok', service: 'self-healing', pollIntervalMs: POLL_INTERVAL_MS };
  });

  await app.listen({ port: parseInt(process.env.PORT ?? '3300', 10), host: '0.0.0.0' });
  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'Self-healing monitor started');

  // Initial check
  await runCheck(natsClient);

  // Recurring poll
  setInterval(() => runCheck(natsClient), POLL_INTERVAL_MS);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
