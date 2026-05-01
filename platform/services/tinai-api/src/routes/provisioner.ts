import { FastifyInstance } from 'fastify'
import * as k8s from '@kubernetes/client-node'
import { loadConfig } from '../config'

/**
 * Namespace Provisioner — automatically provisions tenant namespaces with:
 *   1. Registry pull secrets (copied from tinai-system)
 *   2. Wildcard TLS secret (copied from tinai-system)
 *   3. NetworkPolicies (deny-all + allow ingress-nginx + allow tinai-system + allow DNS + allow same-ns)
 *   4. ResourceQuota + LimitRange based on tenant plan
 *   5. Kyverno-compliant labels
 *
 * Called internally by apps.ts when a new app is created, or via admin API.
 */

const cfg = loadConfig()

const kc = new k8s.KubeConfig()
try {
  kc.loadFromCluster()
} catch {
  kc.loadFromDefault()
}
const coreV1 = kc.makeApiClient(k8s.CoreV1Api)
const netV1 = kc.makeApiClient(k8s.NetworkingV1Api)

// Plan-based resource quotas
const PLAN_QUOTAS: Record<string, Record<string, string>> = {
  free: {
    'requests.cpu': '2',
    'requests.memory': '4Gi',
    'limits.cpu': '4',
    'limits.memory': '8Gi',
    pods: '10',
    services: '5',
    persistentvolumeclaims: '2',
  },
  starter: {
    'requests.cpu': '4',
    'requests.memory': '8Gi',
    'limits.cpu': '8',
    'limits.memory': '16Gi',
    pods: '20',
    services: '10',
    persistentvolumeclaims: '5',
  },
  pro: {
    'requests.cpu': '8',
    'requests.memory': '16Gi',
    'limits.cpu': '16',
    'limits.memory': '32Gi',
    pods: '50',
    services: '20',
    persistentvolumeclaims: '10',
  },
  enterprise: {
    'requests.cpu': '16',
    'requests.memory': '32Gi',
    'limits.cpu': '32',
    'limits.memory': '64Gi',
    pods: '100',
    services: '50',
    persistentvolumeclaims: '20',
  },
}

interface ProvisionRequest {
  namespace: string
  tenantId: string
  plan?: string
}

/**
 * Provisions a complete tenant namespace with all required K8s resources.
 * Idempotent — safe to call multiple times.
 */
export async function provisionNamespace(
  namespace: string,
  tenantId: string,
  plan: string = 'starter',
  log: { info: Function; warn: Function; error: Function },
): Promise<{ success: boolean; steps: string[] }> {
  const steps: string[] = []

  // 1. Create namespace
  try {
    await coreV1.readNamespace(namespace)
    steps.push(`namespace/${namespace} already exists`)
  } catch {
    await coreV1.createNamespace({
      metadata: {
        name: namespace,
        labels: {
          'tinai.cloud/managed-by': 'tinai-infra',
          'tinai.cloud/tenant-id': tenantId,
          'tinai.cloud/plan': plan,
        },
      },
    })
    steps.push(`namespace/${namespace} created`)
  }

  // 2. Copy registry pull secret from tinai-system
  try {
    await coreV1.readNamespacedSecret('e2e-registry-secret', namespace)
    steps.push('e2e-registry-secret already exists')
  } catch {
    try {
      const { body: sourceSecret } = await coreV1.readNamespacedSecret('e2e-registry-secret', 'tinai-system')
      await coreV1.createNamespacedSecret(namespace, {
        metadata: {
          name: 'e2e-registry-secret',
          namespace,
          labels: {
            'tinai.cloud/managed-by': 'tinai-infra',
            'tinai.cloud/tenant-id': tenantId,
          },
        },
        type: sourceSecret.type,
        data: sourceSecret.data,
      })
      steps.push('e2e-registry-secret copied from tinai-system')
    } catch (e: any) {
      log.warn({ err: e.message }, 'failed to copy registry secret')
      steps.push(`e2e-registry-secret FAILED: ${e.message}`)
    }
  }

  // 3. Copy wildcard TLS secret (if exists)
  try {
    await coreV1.readNamespacedSecret('wildcard-apps-tls', namespace)
    steps.push('wildcard-apps-tls already exists')
  } catch {
    try {
      const { body: tlsSecret } = await coreV1.readNamespacedSecret('wildcard-apps-tls', 'tinai-system')
      await coreV1.createNamespacedSecret(namespace, {
        metadata: {
          name: 'wildcard-apps-tls',
          namespace,
          labels: {
            'tinai.cloud/managed-by': 'tinai-infra',
            'tinai.cloud/tenant-id': tenantId,
          },
        },
        type: tlsSecret.type,
        data: tlsSecret.data,
      })
      steps.push('wildcard-apps-tls copied from tinai-system')
    } catch {
      steps.push('wildcard-apps-tls not available — individual certs will be issued per app')
    }
  }

  // 4. NetworkPolicies
  const networkPolicies = [
    {
      name: 'default-deny-all',
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
      },
    },
    {
      name: 'allow-egress-dns',
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [{
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        }],
      },
    },
    {
      name: 'allow-from-ingress-nginx',
      spec: {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [{
          from: [{
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
            },
          }],
        }],
      },
    },
    {
      name: 'allow-from-tinai-system',
      spec: {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [{
          from: [{
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'tinai-system' },
            },
          }],
        }],
      },
    },
    {
      name: 'allow-same-namespace',
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        ingress: [{ from: [{ podSelector: {} }] }],
        egress: [{ to: [{ podSelector: {} }] }],
      },
    },
    {
      name: 'allow-egress-internet',
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [{
          to: [{
            ipBlock: {
              cidr: '0.0.0.0/0',
              except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
            },
          }],
          ports: [
            { protocol: 'TCP', port: 443 },
            { protocol: 'TCP', port: 80 },
          ],
        }],
      },
    },
  ]

  for (const np of networkPolicies) {
    try {
      await netV1.readNamespacedNetworkPolicy(np.name, namespace)
      steps.push(`networkpolicy/${np.name} already exists`)
    } catch {
      await netV1.createNamespacedNetworkPolicy(namespace, {
        metadata: {
          name: np.name,
          namespace,
          labels: {
            'tinai.cloud/managed-by': 'tinai-infra',
            'tinai.cloud/tenant-id': tenantId,
          },
        },
        spec: np.spec as any,
      })
      steps.push(`networkpolicy/${np.name} created`)
    }
  }

  // 5. ResourceQuota
  const quotas = PLAN_QUOTAS[plan] ?? PLAN_QUOTAS.starter
  try {
    await coreV1.readNamespacedResourceQuota('tenant-quota', namespace)
    // Update existing quota for plan changes
    await coreV1.replaceNamespacedResourceQuota('tenant-quota', namespace, {
      metadata: {
        name: 'tenant-quota',
        namespace,
        labels: {
          'tinai.cloud/managed-by': 'tinai-infra',
          'tinai.cloud/tenant-id': tenantId,
        },
      },
      spec: { hard: quotas },
    })
    steps.push(`resourcequota/tenant-quota updated for plan: ${plan}`)
  } catch {
    await coreV1.createNamespacedResourceQuota(namespace, {
      metadata: {
        name: 'tenant-quota',
        namespace,
        labels: {
          'tinai.cloud/managed-by': 'tinai-infra',
          'tinai.cloud/tenant-id': tenantId,
        },
      },
      spec: { hard: quotas },
    })
    steps.push(`resourcequota/tenant-quota created for plan: ${plan}`)
  }

  // 6. LimitRange
  try {
    await coreV1.readNamespacedLimitRange('tenant-limits', namespace)
    steps.push('limitrange/tenant-limits already exists')
  } catch {
    await coreV1.createNamespacedLimitRange(namespace, {
      metadata: {
        name: 'tenant-limits',
        namespace,
        labels: {
          'tinai.cloud/managed-by': 'tinai-infra',
          'tinai.cloud/tenant-id': tenantId,
        },
      },
      spec: {
        limits: [{
          type: 'Container',
          // @ts-ignore K8s type mismatch
          default: { cpu: '500m', memory: '256Mi' } as any,
          defaultRequest: { cpu: '100m', memory: '128Mi' },
          max: { cpu: '2', memory: '4Gi' },
        }],
      },
    })
    steps.push('limitrange/tenant-limits created')
  }

  log.info({ namespace, tenantId, plan, steps }, 'namespace provisioned')
  return { success: true, steps }
}

export async function provisionerRoutes(app: FastifyInstance) {
  // Admin-only endpoint to provision a namespace
  app.post<{ Body: ProvisionRequest }>('/admin/provision-namespace', async (req, reply) => {
    const role = (req as any).role
    if (role !== 'admin') {
      return reply.status(403).send({ error: 'admin access required' })
    }

    const { namespace, tenantId, plan } = req.body
    if (!namespace || !tenantId) {
      return reply.status(400).send({ error: 'namespace and tenantId are required' })
    }

    // Validate namespace format
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(namespace)) {
      return reply.status(400).send({ error: 'namespace must be lowercase alphanumeric with hyphens, 2-63 chars' })
    }

    const result = await provisionNamespace(namespace, tenantId, plan ?? 'starter', req.log)

    // Notify tinai-forge so it seeds forge_tenant_versions for this new tenant.
    // Fire-and-forget — provisioning succeeds even if forge is not yet deployed.
    const forgeURL = process.env.FORGE_API_URL || 'http://tinai-forge.tinai-forge.svc.cluster.local:8090'
    const forgeKey = process.env.FORGE_API_KEY || ''
    if (forgeKey) {
      fetch(`${forgeURL}/api/forge/tenants/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-API-Key': forgeKey },
        body: JSON.stringify({ tenant_id: tenantId, namespace, plan: plan ?? 'starter' }),
        signal: AbortSignal.timeout(5000),
      }).catch((err: Error) => {
        req.log.warn({ err: err.message }, 'forge tenant registration failed (non-fatal)')
      })
    }

    return result
  })

  // Get namespace provisioning status
  app.get<{ Params: { namespace: string } }>('/admin/namespaces/:namespace/status', async (req, reply) => {
    const role = (req as any).role
    if (role !== 'admin') {
      return reply.status(403).send({ error: 'admin access required' })
    }

    const { namespace } = req.params
    try {
      const { body: ns } = await coreV1.readNamespace(namespace)
      const { body: secrets } = await coreV1.listNamespacedSecret(namespace)
      const { body: netpols } = await netV1.listNamespacedNetworkPolicy(namespace)
      const { body: quotas } = await coreV1.listNamespacedResourceQuota(namespace)

      return {
        namespace: ns.metadata?.name,
        labels: ns.metadata?.labels,
        phase: ns.status?.phase,
        secrets: secrets.items.map(s => s.metadata?.name),
        networkPolicies: netpols.items.map(np => np.metadata?.name),
        resourceQuotas: quotas.items.map(q => ({
          name: q.metadata?.name,
          hard: q.spec?.hard,
          used: q.status?.used,
        })),
      }
    } catch (e: any) {
      return reply.status(404).send({ error: `namespace not found: ${e.message}` })
    }
  })
}
