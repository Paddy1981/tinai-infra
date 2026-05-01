// plan-handler/src/index.js
// Service: Plan Change Handler
//
// Handles tenant plan upgrades and downgrades.
// Triggered by:
//   a) Control Plane API → POST /internal/plan-change
//   b) NATS subject: tinai.tenant.plan.changed (from dashboard/API)
//
// Actions:
//   1. Update K8s ResourceQuota in tenant namespace
//   2. Switch Lago subscription plan
//   3. Send confirmation email
//   4. Publish audit event

import Fastify from 'fastify';
import { timingSafeEqual } from 'crypto';
import pino from 'pino';
import { config, validateRequired } from '../../shared/config.js';
import { connectNATS, publish, publishAudit, publishToDLQ } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { tenantToNamespace } from '../../shared/k8s-namespace.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

// ── Plan definitions ──────────────────────────────────────────────────────────
// Mirror these in your Lago plan codes and dashboard UI.
export const PLANS = {
  starter: {
    code: 'starter',
    label: 'Starter',
    priceInr: 499,
    priceUsd: 9,
    quota: {
      cpu: '500m',
      memory: '512Mi',
      storage: '5Gi',
      pods: '10',
    },
  },
  pro: {
    code: 'pro',
    label: 'Pro',
    priceInr: 1999,
    priceUsd: 29,
    quota: {
      cpu: '2000m',
      memory: '4Gi',
      storage: '50Gi',
      pods: '50',
    },
  },
  scale: {
    code: 'scale',
    label: 'Scale',
    priceInr: 7999,
    priceUsd: 99,
    quota: {
      cpu: '8000m',
      memory: '16Gi',
      storage: '200Gi',
      pods: '200',
    },
  },
  enterprise: {
    code: 'enterprise',
    label: 'Enterprise',
    priceInr: null, // custom
    priceUsd: null,
    quota: {
      cpu: '32000m',
      memory: '64Gi',
      storage: '1Ti',
      pods: '1000',
    },
  },
};

// ── K8s ResourceQuota updater ─────────────────────────────────────────────────
const K8S_API = 'https://kubernetes.default.svc';

async function updateResourceQuota(namespace, quota, logger) {
  const token = process.env.K8S_TOKEN ??
    (await import('fs')).readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf-8').trim();

  const body = {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name: 'tenant-quota', namespace },
    spec: {
      hard: {
        'requests.cpu':    quota.cpu,
        'requests.memory': quota.memory,
        'limits.cpu':      quota.cpu,
        'limits.memory':   quota.memory,
        'requests.storage': quota.storage,
        pods:               quota.pods,
      },
    },
  };

  // Try PATCH first (update existing), fall back to POST (create new)
  const patchRes = await fetch(
    `${K8S_API}/api/v1/namespaces/${namespace}/resourcequotas/tenant-quota`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/merge-patch+json',
      },
      body: JSON.stringify(body),
    }
  );

  if (patchRes.ok) {
    logger.info({ namespace, quota }, 'ResourceQuota updated');
    return;
  }

  if (patchRes.status === 404) {
    const createRes = await fetch(
      `${K8S_API}/api/v1/namespaces/${namespace}/resourcequotas`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    if (!createRes.ok) throw new Error(`Create quota failed: ${createRes.status}`);
    logger.info({ namespace, quota }, 'ResourceQuota created');
    return;
  }

  throw new Error(`ResourceQuota PATCH failed: ${patchRes.status}: ${await patchRes.text()}`);
}

// ── Lago subscription plan switcher ──────────────────────────────────────────
async function switchLagoPlan(externalSubscriptionId, newPlanCode, logger) {
  const res = await fetch(
    `${config.lago.url}/api/v1/subscriptions/${externalSubscriptionId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.lago.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscription: { plan_code: newPlanCode },
      }),
    }
  );
  if (!res.ok) throw new Error(`Lago plan switch failed: ${res.status}: ${await res.text()}`);
  logger.info({ externalSubscriptionId, newPlanCode }, 'Lago plan switched');
}

// ── Plan change email ─────────────────────────────────────────────────────────
function buildPlanChangeEmail(tenant, fromPlan, toPlan, currency) {
  const isUpgrade = Object.keys(PLANS).indexOf(toPlan.code) > Object.keys(PLANS).indexOf(fromPlan.code);
  const price = currency === 'INR' ? `₹${toPlan.priceInr}/mo` : `$${toPlan.priceUsd}/mo`;

  return {
    subject: `Plan ${isUpgrade ? 'upgraded' : 'changed'} to ${toPlan.label} — Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:32px">
  <p style="font-size:18px;font-weight:600;margin:0 0 8px">
    ${isUpgrade ? '🎉 Plan upgraded' : 'Plan changed'} to ${toPlan.label}
  </p>
  <p style="color:#444;font-size:14px;line-height:1.6">
    Your plan has been changed from <strong>${fromPlan.label}</strong> to 
    <strong>${toPlan.label}</strong> (${price}).
  </p>
  <div style="background:#f8fafc;border-radius:6px;padding:16px;margin:16px 0;font-size:13px">
    <p style="font-weight:600;margin:0 0 8px">New resource limits:</p>
    <p style="margin:2px 0;color:#444">CPU: ${toPlan.quota.cpu}</p>
    <p style="margin:2px 0;color:#444">Memory: ${toPlan.quota.memory}</p>
    <p style="margin:2px 0;color:#444">Storage: ${toPlan.quota.storage}</p>
    <p style="margin:2px 0;color:#444">Pods: ${toPlan.quota.pods}</p>
  </div>
  <p style="color:#444;font-size:14px">Changes are effective immediately. Your next invoice will reflect the new plan.</p>
  <a href="https://tinai.cloud/billing" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;margin-top:8px">View billing</a>
  <p style="color:#94a3b8;font-size:12px;margin-top:24px">Tinai Cloud · billing@tinai.cloud</p>
</div></body></html>`,
  };
}

// ── Core plan change logic ────────────────────────────────────────────────────
async function executePlanChange({ tenantId, fromPlanCode, toPlanCode, tenantEmail, currency }, natsClient) {
  const fromPlan = PLANS[fromPlanCode];
  const toPlan = PLANS[toPlanCode];

  if (!fromPlan || !toPlan) throw new Error(`Unknown plan: ${fromPlanCode} → ${toPlanCode}`);
  if (fromPlanCode === toPlanCode) throw new Error('From and to plan are the same');

  const namespace = tenantToNamespace(tenantId, config.k8s.tenantNsPrefix);
  logger.info({ tenantId, fromPlanCode, toPlanCode, namespace }, 'Executing plan change');

  // 1. Update K8s ResourceQuota
  await updateResourceQuota(namespace, toPlan.quota, logger);

  // 2. Switch Lago subscription plan
  await switchLagoPlan(tenantId, toPlanCode, logger);

  // 3. Send confirmation email
  if (tenantEmail) {
    const email = buildPlanChangeEmail({ id: tenantId }, fromPlan, toPlan, currency ?? 'INR');
    await sendEmail({ to: tenantEmail, ...email }, logger);
  }

  // 4. Publish events
  publish(natsClient, config.nats.subjects.planChanged, {
    tenantId, fromPlanCode, toPlanCode,
    timestamp: new Date().toISOString(),
  }, logger);

  publishAudit(natsClient, {
    event: 'tenant.plan.changed',
    tenantId, fromPlanCode, toPlanCode,
  }, logger);

  logger.info({ tenantId, toPlanCode }, 'Plan change complete');
  return { success: true, tenantId, toPlanCode, quota: toPlan.quota };
}

// ── Fastify server ────────────────────────────────────────────────────────────
async function main() {
  validateRequired(['lago.apiKey']);

  const natsClient = await connectNATS(logger);
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body)); } catch (e) { done(e); }
  });

  // ── Internal plan change endpoint (called by Control Plane API) ───────────
  app.post('/internal/plan-change', async (req, reply) => {
    const token = req.headers['x-admin-token'] ?? '';
    const expected = config.service.adminToken;
    if (!expected || !token ||
        token.length !== expected.length ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const { tenantId, fromPlanCode, toPlanCode, tenantEmail, currency } = req.body;
    if (!tenantId || !fromPlanCode || !toPlanCode) {
      return reply.code(400).send({ error: 'tenantId, fromPlanCode, toPlanCode required' });
    }

    try {
      const result = await executePlanChange(
        { tenantId, fromPlanCode, toPlanCode, tenantEmail, currency },
        natsClient
      );
      return reply.send(result);
    } catch (err) {
      logger.error({ err: err.message }, 'Plan change failed');
      await publishToDLQ(natsClient, req.body, err, 'plan-handler', logger);
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── Expose plan definitions for dashboard ─────────────────────────────────
  app.get('/plans', async () => ({ plans: PLANS }));

  app.get('/health', async () => ({ status: 'ok', service: 'plan-handler' }));

  await app.listen({ port: config.service.port, host: '0.0.0.0' });
  logger.info({ port: config.service.port }, 'Plan handler listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
