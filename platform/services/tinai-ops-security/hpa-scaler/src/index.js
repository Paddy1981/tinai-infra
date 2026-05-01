// hpa-scaler/src/index.js
// Service: HPA + KEDA Scaling Manager
//
// Manages dynamic autoscaling for tenant workloads.
// Applies KEDA ScaledObjects based on:
//   - HTTP request rate (via Prometheus)
//   - CPU/memory thresholds
//   - Schedule (scale to zero at night for dev tenants)
//
// Triggered by:
//   - NATS: tinai.tenant.provisioned (set up default scaling)
//   - POST /scaling/:tenantId (override scaling config from dashboard)
//   - CronJob: daily reconcile to ensure all tenants have correct scaling

import Fastify from 'fastify';
import pino from 'pino';
import { connect, JSONCodec } from 'nats';
import { config } from '../../shared/config.js';
import { publishAudit } from '../../shared/nats.js';
import { k8sPost, k8sPatch, k8sGet, listNamespaces } from '../../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const jc = JSONCodec();
const TENANT_PREFIX = process.env.TENANT_NS_PREFIX ?? 'tenant-';
const PROM_URL      = process.env.PROMETHEUS_URL   ?? 'http://prometheus-server.monitoring.svc.cluster.local:9090';

// ── Plan-based scaling profiles ───────────────────────────────────────────────
const SCALING_PROFILES = {
  trial: {
    minReplicas: 0,  // scale to zero
    maxReplicas: 1,
    scaleToZeroAfterIdleSecs: 300, // 5 min idle → zero
    triggers: [
      { type: 'cpu',    metadata: { type: 'Utilization', value: '70' } },
    ],
  },
  starter: {
    minReplicas: 1,
    maxReplicas: 3,
    triggers: [
      { type: 'cpu',        metadata: { type: 'Utilization', value: '70' } },
      { type: 'memory',     metadata: { type: 'Utilization', value: '80' } },
      {
        type: 'prometheus',
        metadata: {
          serverAddress: PROM_URL,
          metricName: 'http_requests_per_second',
          threshold: '100',
          query: 'sum(rate(http_requests_total{namespace="NAMESPACE"}[2m]))',
        },
      },
    ],
  },
  pro: {
    minReplicas: 1,
    maxReplicas: 10,
    triggers: [
      { type: 'cpu',    metadata: { type: 'Utilization', value: '60' } },
      { type: 'memory', metadata: { type: 'Utilization', value: '70' } },
      {
        type: 'prometheus',
        metadata: {
          serverAddress: PROM_URL,
          metricName: 'http_requests_per_second',
          threshold: '50',
          query: 'sum(rate(http_requests_total{namespace="NAMESPACE"}[2m]))',
        },
      },
    ],
  },
  scale: {
    minReplicas: 2,
    maxReplicas: 50,
    triggers: [
      { type: 'cpu',    metadata: { type: 'Utilization', value: '50' } },
      { type: 'memory', metadata: { type: 'Utilization', value: '60' } },
      {
        type: 'prometheus',
        metadata: {
          serverAddress: PROM_URL,
          metricName: 'http_requests_per_second',
          threshold: '30',
          query: 'sum(rate(http_requests_total{namespace="NAMESPACE"}[2m]))',
        },
      },
    ],
  },
};

// ── KEDA ScaledObject builder ──────────────────────────────────────────────────
function buildScaledObject(namespace, tenantId, plan = 'starter') {
  const profile = SCALING_PROFILES[plan] ?? SCALING_PROFILES.starter;

  // Replace NAMESPACE placeholder in Prometheus queries
  const triggers = profile.triggers.map(t => ({
    ...t,
    metadata: Object.fromEntries(
      Object.entries(t.metadata).map(([k, v]) => [k, String(v).replace('NAMESPACE', namespace)])
    ),
  }));

  return {
    apiVersion: 'keda.sh/v1alpha1',
    kind: 'ScaledObject',
    metadata: {
      name: 'app-scaler',
      namespace,
      annotations: {
        'tinai.cloud/plan': plan,
        'tinai.cloud/applied-at': new Date().toISOString(),
      },
    },
    spec: {
      scaleTargetRef: { name: 'app', kind: 'Deployment' },
      minReplicaCount: profile.minReplicas,
      maxReplicaCount: profile.maxReplicas,
      ...(profile.scaleToZeroAfterIdleSecs && {
        idleReplicaCount: 0,
        cooldownPeriod: profile.scaleToZeroAfterIdleSecs,
      }),
      triggers,
      advanced: {
        restoreToOriginalReplicaCount: true,
        horizontalPodAutoscalerConfig: {
          behavior: {
            scaleDown: {
              stabilizationWindowSeconds: 300,
              policies: [{ type: 'Percent', value: 50, periodSeconds: 60 }],
            },
            scaleUp: {
              stabilizationWindowSeconds: 30,
              policies: [{ type: 'Percent', value: 100, periodSeconds: 30 }],
            },
          },
        },
      },
    },
  };
}

// ── Apply ScaledObject ────────────────────────────────────────────────────────
async function applyScaledObject(namespace, tenantId, plan) {
  const scaledObject = buildScaledObject(namespace, tenantId, plan);
  try {
    await k8sPatch(
      `/apis/keda.sh/v1alpha1/namespaces/${namespace}/scaledobjects/app-scaler`,
      scaledObject,
      'application/merge-patch+json'
    );
    logger.info({ namespace, plan }, 'ScaledObject updated');
  } catch (err) {
    if (err.message.includes('404')) {
      await k8sPost(`/apis/keda.sh/v1alpha1/namespaces/${namespace}/scaledobjects`, scaledObject);
      logger.info({ namespace, plan }, 'ScaledObject created');
    } else throw err;
  }
}

// ── Reconcile all tenant namespaces ──────────────────────────────────────────
async function reconcileAllTenants() {
  logger.info('HPA reconcile starting');
  const namespaces = await listNamespaces();
  const tenantNS   = namespaces.filter(n => n.metadata.name.startsWith(TENANT_PREFIX));

  let applied = 0, skipped = 0;
  for (const ns of tenantNS) {
    const namespace = ns.metadata.name;
    const tenantId  = namespace.replace(TENANT_PREFIX, '');
    const plan      = ns.metadata.labels?.['tinai.cloud/plan'] ?? 'starter';

    try {
      // Check if deployment 'app' exists before applying scaler
      await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments/app`);
      await applyScaledObject(namespace, tenantId, plan);
      applied++;
    } catch (err) {
      if (err.message.includes('404')) { skipped++; continue; }
      logger.warn({ namespace, err: err.message }, 'ScaledObject apply failed');
    }
  }

  logger.info({ total: tenantNS.length, applied, skipped }, 'HPA reconcile complete');
  return { applied, skipped };
}

// ── Server ────────────────────────────────────────────────────────────────────
async function main() {
  const runMode = process.env.RUN_MODE ?? 'server';

  if (runMode === 'reconcile') {
    // CronJob mode
    const result = await reconcileAllTenants();
    process.exit(0);
  }

  // Server mode — listens for provisioning events + REST API
  const nc  = await connect({ servers: config.nats.servers, reconnect: true, maxReconnectAttempts: -1 });
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body)); } catch (e) { done(e); }
  });

  // Listen for new tenant provisioning
  const sub = nc.subscribe('tinai.tenant.provisioned');
  (async () => {
    for await (const msg of sub) {
      try {
        const { tenantId, namespace, plan } = jc.decode(msg.data);
        // Wait 30s for deployment 'app' to potentially be created first
        setTimeout(async () => {
          try { await applyScaledObject(namespace ?? `tenant-${tenantId}`, tenantId, plan ?? 'starter'); }
          catch (err) { logger.debug({ tenantId, err: err.message }, 'ScaledObject apply deferred (no app yet)'); }
        }, 30_000);
      } catch (err) {
        logger.error({ err: err.message }, 'Provisioning event handler failed');
      }
    }
  })();

  // Override scaling for a specific tenant
  app.post('/scaling/:tenantId', async (req, reply) => {
    const token = req.headers['x-admin-token'];
    if (token !== config.service.adminToken) return reply.code(401).send({ error: 'unauthorized' });

    const { tenantId } = req.params;
    const { plan, minReplicas, maxReplicas } = req.body ?? {};
    const namespace = `${TENANT_PREFIX}${tenantId}`;

    await applyScaledObject(namespace, tenantId, plan ?? 'starter');
    return reply.send({ success: true, tenantId, plan });
  });

  app.post('/reconcile', async (req, reply) => {
    const token = req.headers['x-admin-token'];
    if (token !== config.service.adminToken) return reply.code(401).send({ error: 'unauthorized' });
    reply.code(202).send({ status: 'reconciling' });
    reconcileAllTenants().catch(err => logger.error({ err: err.message }, 'Reconcile failed'));
  });

  app.get('/health', async () => ({ status: 'ok', service: 'hpa-scaler' }));
  app.get('/profiles', async () => ({ profiles: Object.keys(SCALING_PROFILES) }));

  await app.listen({ port: parseInt(process.env.PORT ?? '3404', 10), host: '0.0.0.0' });
  logger.info('HPA scaler service listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
