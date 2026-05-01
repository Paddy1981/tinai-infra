// namespace-provisioner/src/index.js
// Service: Tenant Namespace Provisioner
//
// Triggered by:
//   POST /provision   — Control Plane API calls this after tenant signup
//   NATS: tinai.tenant.signup
//
// Creates in < 60 seconds:
//   - K8s Namespace with labels
//   - ResourceQuota (from plan)
//   - LimitRange (default container limits)
//   - NetworkPolicy (deny all ingress except from ingress controller)
//   - ServiceAccount for tenant workloads
//   - RBAC (tenant can deploy to own namespace only)
//   - Vault namespace path + policy
//   - Lago customer + subscription
//   - Gitea repo (tenant's code repo)
//   - Harbor project (tenant's image registry)
//   - Welcome email sequence trigger via NATS

import Fastify from 'fastify';
import crypto from 'crypto';
import pino from 'pino';
import { config } from '../../shared/config.js';
import { connectNATS, publish, publishAudit, publishToDLQ } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { k8sPost, k8sPatch, k8sGet } from '../../shared/k8s.js';
import { PLANS } from '../../plan-handler/src/index.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const GITEA_URL    = process.env.GITEA_URL    ?? 'https://gitea.tinai.cloud';
const GITEA_TOKEN  = process.env.GITEA_TOKEN  ?? '';
const GITEA_ORG    = process.env.GITEA_ORG    ?? 'tinai-tenants';
const HARBOR_URL   = process.env.HARBOR_URL   ?? 'https://harbor.tinai.cloud';
const HARBOR_USER  = process.env.HARBOR_USER  ?? '';
const HARBOR_PASS  = process.env.HARBOR_PASS  ?? '';
const VAULT_URL    = process.env.VAULT_ADDR   ?? 'http://vault.core.svc.cluster.local:8200';
const VAULT_TOKEN  = process.env.VAULT_TOKEN  ?? '';

// ── K8s resource builders ─────────────────────────────────────────────────────

function buildNamespace(tenantId, plan, metadata = {}) {
  return {
    apiVersion: 'v1', kind: 'Namespace',
    metadata: {
      name: `tenant-${tenantId}`,
      labels: {
        'tinai.cloud/tenant-id': tenantId,
        'tinai.cloud/plan': plan,
        'tinai.cloud/managed': 'true',
        'pod-security.kubernetes.io/enforce': 'baseline',
        'pod-security.kubernetes.io/warn': 'restricted',
      },
      annotations: {
        'tinai.cloud/provisioned-at': new Date().toISOString(),
        'tinai.cloud/tenant-email': metadata.email ?? '',
        'tinai.cloud/tenant-name':  metadata.name  ?? tenantId,
      },
    },
  };
}

function buildResourceQuota(namespace, plan) {
  const quota = PLANS[plan]?.quota ?? PLANS.starter.quota;
  return {
    apiVersion: 'v1', kind: 'ResourceQuota',
    metadata: { name: 'tenant-quota', namespace },
    spec: {
      hard: {
        'requests.cpu':     quota.cpu,
        'requests.memory':  quota.memory,
        'limits.cpu':       quota.cpu,
        'limits.memory':    quota.memory,
        'requests.storage': quota.storage,
        pods:               quota.pods,
        services:           '10',
        'persistentvolumeclaims': '10',
        'configmaps':       '20',
        'secrets':          '20',
      },
    },
  };
}

function buildLimitRange(namespace) {
  return {
    apiVersion: 'v1', kind: 'LimitRange',
    metadata: { name: 'tenant-limits', namespace },
    spec: {
      limits: [
        {
          type: 'Container',
          default:        { cpu: '200m', memory: '256Mi' },
          defaultRequest: { cpu: '50m',  memory: '64Mi'  },
          max:            { cpu: '4',    memory: '8Gi'   },
          min:            { cpu: '10m',  memory: '16Mi'  },
        },
        {
          type: 'PersistentVolumeClaim',
          max:  { storage: '50Gi' },
          min:  { storage: '1Gi'  },
        },
      ],
    },
  };
}

function buildNetworkPolicy(namespace) {
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'tenant-isolation', namespace },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        // Allow from ingress controller only
        { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'traefik' } } }] },
        // Allow intra-namespace (pods talking to each other)
        { from: [{ podSelector: {} }] },
      ],
      egress: [
        // Allow DNS
        { ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
        // Allow HTTPS out (for external API calls)
        { ports: [{ port: 443, protocol: 'TCP' }] },
        // Allow HTTP out
        { ports: [{ port: 80, protocol: 'TCP' }] },
        // Allow intra-namespace
        { to: [{ podSelector: {} }] },
      ],
    },
  };
}

function buildServiceAccount(namespace, tenantId) {
  return {
    apiVersion: 'v1', kind: 'ServiceAccount',
    metadata: {
      name: 'tenant-workload',
      namespace,
      annotations: { 'tinai.cloud/tenant-id': tenantId },
    },
    automountServiceAccountToken: false,
  };
}

function buildRBAC(namespace, tenantId) {
  const roleName = `tenant-${tenantId}-deployer`;
  return {
    role: {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role',
      metadata: { name: roleName, namespace },
      rules: [
        { apiGroups: ['apps'], resources: ['deployments', 'replicasets'], verbs: ['get', 'list', 'create', 'update', 'patch'] },
        { apiGroups: [''], resources: ['services', 'configmaps', 'persistentvolumeclaims'], verbs: ['get', 'list', 'create', 'update', 'patch', 'delete'] },
        { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list'] },
        { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list', 'create', 'update', 'patch'] },
      ],
    },
    roleBinding: {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: `${roleName}-binding`, namespace },
      subjects: [{ kind: 'ServiceAccount', name: 'tenant-workload', namespace }],
      roleRef: { kind: 'Role', name: roleName, apiGroup: 'rbac.authorization.k8s.io' },
    },
  };
}

// ── External service provisioning ─────────────────────────────────────────────

async function provisionLagoCustomer(tenantId, email, name, planCode, currency) {
  const baseUrl = config.lago.url;
  const headers = { Authorization: `Bearer ${config.lago.apiKey}`, 'Content-Type': 'application/json' };

  // Create customer
  await fetch(`${baseUrl}/api/v1/customers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      customer: {
        external_id: tenantId,
        name, email,
        currency: currency ?? 'INR',
        billing_configuration: { payment_provider: currency === 'INR' ? 'gocardless' : 'stripe' },
      },
    }),
  });

  // Create subscription
  await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      subscription: {
        external_customer_id: tenantId,
        plan_code: planCode ?? 'trial',
        external_id: tenantId,
        billing_time: 'anniversary',
      },
    }),
  });

  logger.info({ tenantId, planCode }, 'Lago customer + subscription created');
}

async function provisionGiteaRepo(tenantId) {
  if (!GITEA_TOKEN) return null;
  const res = await fetch(`${GITEA_URL}/api/v1/orgs/${GITEA_ORG}/repos`, {
    method: 'POST',
    headers: { Authorization: `token ${GITEA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: tenantId,
      description: `Tinai tenant repo for ${tenantId}`,
      private: true,
      auto_init: true,
      default_branch: 'main',
    }),
  });
  if (!res.ok) { logger.warn({ status: res.status }, 'Gitea repo creation failed'); return null; }
  const repo = await res.json();
  logger.info({ tenantId, url: repo.html_url }, 'Gitea repo created');
  return repo.clone_url;
}

async function provisionHarborProject(tenantId) {
  if (!HARBOR_USER) return null;
  const auth = 'Basic ' + Buffer.from(`${HARBOR_USER}:${HARBOR_PASS}`).toString('base64');
  const res = await fetch(`${HARBOR_URL}/api/v2.0/projects`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_name: tenantId, public: false, metadata: { public: 'false' } }),
  });
  if (!res.ok) { logger.warn({ status: res.status }, 'Harbor project creation failed'); return null; }
  logger.info({ tenantId }, 'Harbor project created');
  return `${HARBOR_URL}/${tenantId}`;
}

async function provisionVaultNamespace(tenantId) {
  if (!VAULT_TOKEN) return;
  // Create KV secrets engine path for tenant
  await fetch(`${VAULT_URL}/v1/sys/mounts/tenant-${tenantId}`, {
    method: 'POST',
    headers: { 'X-Vault-Token': VAULT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'kv', options: { version: '2' } }),
  });
  // Create policy scoped to this tenant's path
  const policy = `path "tenant-${tenantId}/*" { capabilities = ["create","read","update","delete","list"] }`;
  await fetch(`${VAULT_URL}/v1/sys/policies/acl/tenant-${tenantId}`, {
    method: 'PUT',
    headers: { 'X-Vault-Token': VAULT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  });
  logger.info({ tenantId }, 'Vault namespace + policy created');
}

// ── Tenant ID validation ──────────────────────────────────────────────────────
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// ── Core provisioning flow ────────────────────────────────────────────────────

async function provisionTenant({ tenantId, email, name, plan = 'starter', currency = 'INR' }, natsClient) {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`Invalid tenant ID: ${tenantId}`);
  }

  const namespace = `tenant-${tenantId}`;
  const startedAt = Date.now();
  const results   = {};

  logger.info({ tenantId, plan, namespace }, 'Provisioning tenant');

  // 1. K8s namespace
  await k8sPost('/api/v1/namespaces', buildNamespace(tenantId, plan, { email, name }));
  results.namespace = 'created';
  logger.info({ namespace }, 'Namespace created');

  // 2. ResourceQuota + LimitRange + NetworkPolicy + ServiceAccount + RBAC (parallel)
  const { role, roleBinding } = buildRBAC(namespace, tenantId);
  await Promise.all([
    k8sPost(`/api/v1/namespaces/${namespace}/resourcequotas`,     buildResourceQuota(namespace, plan)),
    k8sPost(`/api/v1/namespaces/${namespace}/limitranges`,        buildLimitRange(namespace)),
    k8sPost(`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`, buildNetworkPolicy(namespace)),
    k8sPost(`/api/v1/namespaces/${namespace}/serviceaccounts`,    buildServiceAccount(namespace, tenantId)),
    k8sPost(`/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/roles`, role),
    k8sPost(`/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`, roleBinding),
  ]);
  results.k8sResources = 'created';
  logger.info({ namespace }, 'K8s resources created');

  // 3. External services (parallel, non-fatal)
  const [lagoResult, giteaUrl, harborUrl] = await Promise.allSettled([
    provisionLagoCustomer(tenantId, email, name, plan, currency),
    provisionGiteaRepo(tenantId),
    provisionHarborProject(tenantId),
    provisionVaultNamespace(tenantId),
  ]);

  results.lago   = lagoResult.status;
  results.gitea  = giteaUrl.status;
  results.harbor = harborUrl.status;

  // 4. Trigger onboarding email sequence via NATS
  publish(natsClient, 'tinai.tenant.provisioned', {
    tenantId, namespace, email, name, plan, currency,
    giteaUrl: giteaUrl.value ?? null,
    harborUrl: harborUrl.value ?? null,
    provisionedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  }, logger);

  publishAudit(natsClient, {
    event: 'tenant.provisioned', tenantId, plan,
    durationMs: Date.now() - startedAt,
  }, logger);

  logger.info({ tenantId, durationMs: Date.now() - startedAt }, 'Tenant provisioned');
  return { tenantId, namespace, results, durationMs: Date.now() - startedAt };
}

// ── Fastify server ────────────────────────────────────────────────────────────

async function main() {
  const natsClient = await connectNATS(logger);
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, JSON.parse(body)); } catch (e) { done(e); }
  });

  app.post('/provision', async (req, reply) => {
    const token = req.headers['x-admin-token'] ?? '';
    const expected = config.service.adminToken;
    if (!token || !expected || token.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const { tenantId, email, name, plan, currency } = req.body ?? {};
    if (!tenantId || !email) return reply.code(400).send({ error: 'tenantId and email required' });

    // Respond immediately — provisioning takes ~5s
    reply.code(202).send({ status: 'provisioning', tenantId });

    provisionTenant({ tenantId, email, name, plan, currency }, natsClient)
      .catch(async err => {
        logger.error({ tenantId, err: err.message }, 'Provisioning failed');
        await publishToDLQ(natsClient, { tenantId, email, plan }, err, 'namespace-provisioner', logger);
      });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'namespace-provisioner' }));

  await app.listen({ port: parseInt(process.env.PORT ?? '3400', 10), host: '0.0.0.0' });
  logger.info('Namespace provisioner listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
