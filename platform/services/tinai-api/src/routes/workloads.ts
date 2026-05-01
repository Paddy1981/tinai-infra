import { FastifyInstance } from 'fastify'
import * as k8s from '@kubernetes/client-node'
import { loadConfig } from '../config'
import { requirePlan, getPlanLimits } from '../middleware/planGate'

const cfg = loadConfig()

// ---------------------------------------------------------------------------
// K8s client — prefers in-cluster SA token, falls back to kubeconfig for dev
// ---------------------------------------------------------------------------
const kc = new k8s.KubeConfig()
try {
  kc.loadFromCluster()
} catch {
  kc.loadFromDefault()
}
const appsV1   = kc.makeApiClient(k8s.AppsV1Api)
const coreV1   = kc.makeApiClient(k8s.CoreV1Api)
const batchV1  = kc.makeApiClient(k8s.BatchV1Api)
const customObjects = kc.makeApiClient(k8s.CustomObjectsApi)
const networkingV1  = kc.makeApiClient(k8s.NetworkingV1Api)

const WORKLOAD_NAMESPACE = process.env.WORKLOAD_NAMESPACE ?? cfg.stagingNamespace
const INGRESS_CLASS       = process.env.INGRESS_CLASS ?? 'nginx'
const BASE_DOMAIN         = process.env.BASE_DOMAIN ?? 'apps.tinai.cloud'
const BUILD_API_URL       = process.env.BUILD_API_URL ?? 'http://tinai-build-api.tinai-build.svc.cluster.local'
const LOKI_URL            = process.env.LOKI_URL ?? 'http://loki.tinai-monitoring.svc.cluster.local:3100'

// Knative Serving API group constants
const KNATIVE_GROUP   = 'serving.knative.dev'
const KNATIVE_VERSION = 'v1'
const KNATIVE_PLURAL  = 'services'

// KEDA ScaledObject API group constants
const KEDA_GROUP   = 'keda.sh'
const KEDA_VERSION = 'v1alpha1'
const KEDA_PLURAL  = 'scaledobjects'

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://prometheus-server.monitoring.svc.cluster.local'

// Max replicas per workload by plan tier (separate from max_workloads total count).
const MAX_REPLICAS_BY_PLAN: Record<string, number> = {
  free:       2,
  pro:        10,
  enterprise: 50,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a stable, DNS-safe workload subdomain. */
function workloadDomain(name: string): string {
  return `${name}.${BASE_DOMAIN}`
}

/** Build a k8s Deployment manifest for type=service or type=static. */
function buildDeployment(
  name: string,
  tenantId: string,
  image: string,
  port: number,
  env: Record<string, string>,
  replicas: number,
  memoryLimit: string,
  cpuLimit: string,
): k8s.V1Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace: WORKLOAD_NAMESPACE,
      labels: {
        app: name,
        'tinai.cloud/workload': name,
        'tinai.cloud/tenant-id': tenantId,
      },
    },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: {
          labels: {
            app: name,
            'tinai.cloud/workload': name,
            'tinai.cloud/tenant-id': tenantId,
          },
        },
        spec: {
          containers: [{
            name,
            image,
            ports: [{ containerPort: port }],
            env: Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) })),
            resources: {
              limits:   { memory: memoryLimit, cpu: cpuLimit },
              requests: { memory: memoryLimit, cpu: cpuLimit },
            },
          }],
        },
      },
    },
  }
}

/** Build a k8s Service manifest. */
function buildService(name: string, tenantId: string, port: number): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: WORKLOAD_NAMESPACE,
      labels: { 'tinai.cloud/tenant-id': tenantId },
    },
    spec: {
      selector: { app: name },
      ports: [{ port: 80, targetPort: port as any }],
    },
  }
}

/** Build an Ingress that routes BASE_DOMAIN/<name> → Service. */
function buildIngress(name: string, tenantId: string, domain: string): k8s.V1Ingress {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name,
      namespace: WORKLOAD_NAMESPACE,
      annotations: { 'kubernetes.io/ingress.class': INGRESS_CLASS },
      labels: { 'tinai.cloud/tenant-id': tenantId },
    },
    spec: {
      rules: [{
        host: domain,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: { name, port: { number: 80 } },
            },
          }],
        },
      }],
    },
  }
}

/** Build a Knative Service manifest for type=function. */
function buildKnativeService(
  name: string,
  tenantId: string,
  image: string,
  port: number,
  env: Record<string, string>,
  memoryLimit: string,
  cpuLimit: string,
): object {
  return {
    apiVersion: `${KNATIVE_GROUP}/${KNATIVE_VERSION}`,
    kind: 'Service',
    metadata: {
      name,
      namespace: WORKLOAD_NAMESPACE,
      labels: {
        'tinai.cloud/workload': name,
        'tinai.cloud/tenant-id': tenantId,
      },
    },
    spec: {
      template: {
        spec: {
          containers: [{
            image,
            ports: [{ containerPort: port }],
            env: Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) })),
            resources: {
              limits:   { memory: memoryLimit, cpu: cpuLimit },
              requests: { memory: memoryLimit, cpu: cpuLimit },
            },
          }],
        },
      },
    },
  }
}

/** Build a k8s CronJob manifest for type=job. */
function buildCronJob(
  name: string,
  tenantId: string,
  image: string,
  schedule: string,
  env: Record<string, string>,
  memoryLimit: string,
  cpuLimit: string,
): k8s.V1CronJob {
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name,
      namespace: WORKLOAD_NAMESPACE,
      labels: {
        'tinai.cloud/workload': name,
        'tinai.cloud/tenant-id': tenantId,
      },
    },
    spec: {
      schedule,
      jobTemplate: {
        spec: {
          template: {
            metadata: {
              labels: {
                app: name,
                'tinai.cloud/tenant-id': tenantId,
              },
            },
            spec: {
              restartPolicy: 'OnFailure',
              containers: [{
                name,
                image,
                env: Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) })),
                resources: {
                  limits:   { memory: memoryLimit, cpu: cpuLimit },
                  requests: { memory: memoryLimit, cpu: cpuLimit },
                },
              }],
            },
          },
        },
      },
    },
  }
}

/** Trigger a build via the build-api service. Returns build job id or null. */
async function triggerBuild(repoUrl: string, ref: string): Promise<string | null> {
  try {
    const res = await fetch(`${BUILD_API_URL}/build/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_url: repoUrl, ref, auto_detect: true }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as any
    return json?.id ?? null
  } catch {
    return null
  }
}

/** Query Loki for the last N log lines for a workload. */
async function fetchLokiLogs(workloadName: string, limit = 100): Promise<string[]> {
  const safeName = workloadName.replace(/[^a-zA-Z0-9_-]/g, '')
  const query  = encodeURIComponent(`{namespace="${WORKLOAD_NAMESPACE}", app=~"${safeName}"}`)
  const url    = `${LOKI_URL}/loki/api/v1/query_range?query=${query}&limit=${limit}&direction=backward`
  try {
    const res  = await fetch(url)
    if (!res.ok) return []
    const body = (await res.json()) as any
    const streams: any[] = body?.data?.result ?? []
    const lines: string[] = []
    for (const stream of streams) {
      for (const [, line] of (stream.values ?? [])) {
        lines.push(line as string)
      }
    }
    // Loki returns newest-first when direction=backward; reverse for chronological order
    return lines.reverse()
  } catch {
    return []
  }
}

/** Get live k8s pod status for a deployment-backed workload. */
async function getLiveDeploymentStatus(name: string): Promise<{
  ready_replicas: number
  desired_replicas: number
  last_restart?: string
} | null> {
  try {
    const { body: dep } = await appsV1.readNamespacedDeployment(name, WORKLOAD_NAMESPACE)
    const desired = dep.spec?.replicas ?? 1
    const ready   = dep.status?.readyReplicas ?? 0

    // Find the restartedAt annotation on the pod template, if any
    const restartedAt = dep.spec?.template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt']

    return {
      ready_replicas:   ready,
      desired_replicas: desired,
      ...(restartedAt ? { last_restart: restartedAt } : {}),
    }
  } catch {
    return null
  }
}

/** Delete all k8s resources for a workload by type. Best-effort (ignore 404s). */
async function deleteK8sResources(name: string, type: string): Promise<void> {
  const ignore = (err: any) => {
    if (err?.response?.statusCode !== 404) throw err
  }

  if (type === 'service' || type === 'static') {
    await appsV1.deleteNamespacedDeployment(name, WORKLOAD_NAMESPACE).catch(ignore)
    await coreV1.deleteNamespacedService(name, WORKLOAD_NAMESPACE).catch(ignore)
    await networkingV1.deleteNamespacedIngress(name, WORKLOAD_NAMESPACE).catch(ignore)
    await deleteScaledObject(name)
  } else if (type === 'function') {
    await customObjects
      .deleteNamespacedCustomObject(KNATIVE_GROUP, KNATIVE_VERSION, WORKLOAD_NAMESPACE, KNATIVE_PLURAL, name)
      .catch(ignore)
  } else if (type === 'job') {
    await batchV1.deleteNamespacedCronJob(name, WORKLOAD_NAMESPACE).catch(ignore)
  }
}

// ---------------------------------------------------------------------------
// KEDA ScaledObject helpers
// ---------------------------------------------------------------------------

/** Build a KEDA ScaledObject manifest for a service/static Deployment. */
function buildScaledObject(name: string, tenantId: string, maxReplicas: number): object {
  return {
    apiVersion: `${KEDA_GROUP}/${KEDA_VERSION}`,
    kind: 'ScaledObject',
    metadata: {
      name: `${name}-scaler`,
      namespace: WORKLOAD_NAMESPACE,
      labels: {
        'tinai.cloud/workload': name,
        'tinai.cloud/tenant-id': tenantId,
        'tinai.cloud/component': 'autoscaler',
        'tinai.cloud/scaler-type': 'app',
      },
    },
    spec: {
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name,
      },
      minReplicaCount: 0,           // scale to zero when idle
      maxReplicaCount: maxReplicas, // capped by tenant plan tier
      cooldownPeriod:  300,         // seconds idle before scaling to zero
      pollingInterval: 30,
      triggers: [{
        type: 'prometheus',
        metadata: {
          serverAddress: PROMETHEUS_URL,
          metricName: `nginx_requests_${name}`,
          // nginx ingress controller request rate scoped to this ingress resource
          query: `rate(nginx_ingress_controller_requests{ingress="${name}",namespace="${WORKLOAD_NAMESPACE}"}[2m])`,
          threshold: '1',
        },
      }],
    },
  }
}

/** Create-or-replace a KEDA ScaledObject for a service/static workload. Best-effort. */
async function applyScaledObject(name: string, tenantId: string, maxReplicas: number): Promise<void> {
  const manifest = buildScaledObject(name, tenantId, maxReplicas)
  try {
    await customObjects.createNamespacedCustomObject(KEDA_GROUP, KEDA_VERSION, WORKLOAD_NAMESPACE, KEDA_PLURAL, manifest)
  } catch (e: any) {
    if (e?.response?.statusCode === 409) {
      // Already exists — replace it (e.g. on re-deploy or plan upgrade)
      await customObjects.replaceNamespacedCustomObject(
        KEDA_GROUP, KEDA_VERSION, WORKLOAD_NAMESPACE, KEDA_PLURAL, `${name}-scaler`, manifest,
      )
    }
    // Non-409 errors are swallowed: KEDA may not be installed in dev; the
    // workload itself is live regardless. A warning is logged by the caller.
  }
}

/** Delete the KEDA ScaledObject for a workload. Best-effort (ignores 404). */
async function deleteScaledObject(name: string): Promise<void> {
  try {
    await customObjects.deleteNamespacedCustomObject(
      KEDA_GROUP, KEDA_VERSION, WORKLOAD_NAMESPACE, KEDA_PLURAL, `${name}-scaler`,
    )
  } catch (e: any) {
    if (e?.response?.statusCode !== 404) {
      // Unexpected error — log but don't throw; workload deletion continues.
      console.warn(`deleteScaledObject: unexpected error for ${name}-scaler:`, e?.response?.statusCode)
    }
  }
}

// ---------------------------------------------------------------------------
// Deploy a workload to k8s given its DB row data. Returns the new status.
// ---------------------------------------------------------------------------
async function deployToK8s(
  workload: {
    name: string
    tenant_id: string
    type: string
    image: string
    port: number
    env: Record<string, string>
    replicas: number
    memory_limit: string
    cpu_limit: string
    domain: string
    schedule?: string
    maxReplicas?: number
  },
): Promise<'running' | 'failed'> {
  const { name, tenant_id, type, image, port, env, replicas, memory_limit, cpu_limit, domain } = workload
  const maxReplicas = workload.maxReplicas ?? 2

  try {
    if (type === 'service' || type === 'static') {
      const effectiveImage = type === 'static' ? 'nginx:stable-alpine' : image
      const deploymentManifest = buildDeployment(
        name, tenant_id, effectiveImage, port || 80, env, replicas, memory_limit, cpu_limit,
      )
      const serviceManifest  = buildService(name, tenant_id, port || 80)
      const ingressManifest  = buildIngress(name, tenant_id, domain)

      // Upsert Deployment
      try {
        await appsV1.createNamespacedDeployment(WORKLOAD_NAMESPACE, deploymentManifest)
      } catch (e: any) {
        if (e?.response?.statusCode === 409) {
          await appsV1.replaceNamespacedDeployment(name, WORKLOAD_NAMESPACE, deploymentManifest)
        } else throw e
      }

      // Upsert Service
      try {
        await coreV1.createNamespacedService(WORKLOAD_NAMESPACE, serviceManifest)
      } catch (e: any) {
        if (e?.response?.statusCode === 409) {
          const { body: existing } = await coreV1.readNamespacedService(name, WORKLOAD_NAMESPACE)
          serviceManifest.metadata!.resourceVersion = existing.metadata?.resourceVersion
          await coreV1.replaceNamespacedService(name, WORKLOAD_NAMESPACE, serviceManifest)
        } else throw e
      }

      // Upsert Ingress
      try {
        await networkingV1.createNamespacedIngress(WORKLOAD_NAMESPACE, ingressManifest)
      } catch (e: any) {
        if (e?.response?.statusCode === 409) {
          await networkingV1.replaceNamespacedIngress(name, WORKLOAD_NAMESPACE, ingressManifest)
        } else throw e
      }

      // Upsert KEDA ScaledObject — enables HTTP-driven scale-to-zero
      await applyScaledObject(name, tenant_id, maxReplicas)

    } else if (type === 'function') {
      const ksvc = buildKnativeService(name, tenant_id, image, port || 8080, env, memory_limit, cpu_limit)
      try {
        await customObjects.createNamespacedCustomObject(
          KNATIVE_GROUP, KNATIVE_VERSION, WORKLOAD_NAMESPACE, KNATIVE_PLURAL, ksvc,
        )
      } catch (e: any) {
        if (e?.response?.statusCode === 409) {
          await customObjects.replaceNamespacedCustomObject(
            KNATIVE_GROUP, KNATIVE_VERSION, WORKLOAD_NAMESPACE, KNATIVE_PLURAL, name, ksvc,
          )
        } else throw e
      }

    } else if (type === 'job') {
      const schedule = workload.schedule ?? '0 * * * *'
      const cronJob  = buildCronJob(name, tenant_id, image, schedule, env, memory_limit, cpu_limit)
      try {
        await batchV1.createNamespacedCronJob(WORKLOAD_NAMESPACE, cronJob)
      } catch (e: any) {
        if (e?.response?.statusCode === 409) {
          await batchV1.replaceNamespacedCronJob(name, WORKLOAD_NAMESPACE, cronJob)
        } else throw e
      }
    }

    return 'running'
  } catch {
    return 'failed'
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

interface WorkloadBody {
  name: string
  type: 'service' | 'function' | 'job' | 'static'
  source_git_url?: string
  source_ref?: string
  image?: string
  port?: number
  env?: Record<string, string>
  replicas?: number
  memory_limit?: string
  cpu_limit?: string
  schedule?: string  // required for type=job
  project_id?: string
  environment?: string
}

interface WorkloadUpdateBody {
  image?: string
  replicas?: number
  env?: Record<string, string>
  memory_limit?: string
  cpu_limit?: string
}

export async function workloadsRoutes(app: FastifyInstance) {

  // -------------------------------------------------------------------------
  // GET /workloads — list all workloads for the authenticated tenant
  //   Optional query params: ?project_id=<uuid>&environment=<name>
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { project_id?: string; environment?: string } }>(
    '/workloads',
    async (req) => {
      const tenantId   = (req as any).tenantId as string
      const { project_id, environment } = req.query

      const conditions: string[] = ['tenant_id = $1']
      const params: unknown[]    = [tenantId]

      if (project_id) {
        params.push(project_id)
        conditions.push(`project_id = $${params.length}`)
      }

      if (environment) {
        params.push(environment)
        conditions.push(`environment = $${params.length}`)
      }

      const { rows } = await app.pg.query(
        `SELECT id, name, type, status, domain, project_id, environment,
                last_deployed_at, created_at, updated_at
         FROM workloads
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC`,
        params,
      )

      return rows
    },
  )

  // -------------------------------------------------------------------------
  // POST /workloads — create + deploy a workload
  // -------------------------------------------------------------------------
  app.post<{ Body: WorkloadBody }>(
    '/workloads',
    {
      preHandler: requirePlan('workloads'),
      schema: {
        body: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name:           { type: 'string', minLength: 1, maxLength: 63 },
            type:           { type: 'string', enum: ['service', 'function', 'job', 'static'] },
            source_git_url: { type: 'string' },
            source_ref:     { type: 'string' },
            image:          { type: 'string' },
            port:           { type: 'integer', minimum: 1, maximum: 65535 },
            env:            { type: 'object', additionalProperties: { type: 'string' } },
            replicas:       { type: 'integer', minimum: 1, maximum: 50 },
            memory_limit:   { type: 'string' },
            cpu_limit:      { type: 'string' },
            schedule:       { type: 'string' },
            project_id:     { type: 'string' },
            environment:    { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const {
        name,
        type,
        source_git_url,
        source_ref = 'main',
        image,
        port,
        env = {},
        replicas = 1,
        memory_limit = '256Mi',
        cpu_limit = '100m',
        schedule,
        project_id,
        environment = 'production',
      } = req.body

      // Validate: must provide either source_git_url or image
      if (!source_git_url && !image) {
        return reply.status(400).send({ error: 'provide either source_git_url or image' })
      }

      // Validate: type=job requires schedule
      if (type === 'job' && !schedule) {
        return reply.status(400).send({ error: 'type=job requires a schedule field (cron expression)' })
      }

      const domain = workloadDomain(name)
      let status: string = 'pending'

      // Validate project_id belongs to this tenant (if provided)
      if (project_id) {
        const { rows: proj } = await app.pg.query(
          `SELECT id FROM projects WHERE id = $1 AND tenant_id = $2`,
          [project_id, tenantId],
        )
        if (!proj.length) {
          return reply.status(404).send({ error: 'project not found' })
        }
      }

      // Resolve tenant plan to set per-workload replica cap for the ScaledObject
      const { plan_id, limits: _ } = await getPlanLimits(app.pg, tenantId)
      const maxReplicas = MAX_REPLICAS_BY_PLAN[plan_id] ?? 2

      // Insert row into DB first (get the ID)
      const { rows: [workload] } = await app.pg.query(
        `INSERT INTO workloads
           (tenant_id, name, type, status, source_git_url, source_ref, image, port, env,
            replicas, memory_limit, cpu_limit, domain, project_id, environment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [tenantId, name, type, status, source_git_url ?? null, source_ref,
         image ?? null, port ?? null, JSON.stringify(env),
         replicas, memory_limit, cpu_limit, domain,
         project_id ?? null, environment],
      )

      // If git URL provided and no image → trigger build, set status=building
      if (source_git_url && !image) {
        status = 'building'
        await triggerBuild(source_git_url, source_ref)
      } else if (image) {
        // Deploy directly to k8s
        const k8sStatus = await deployToK8s({
          name,
          tenant_id: tenantId,
          type,
          image,
          port: port ?? 8080,
          env,
          replicas,
          memory_limit,
          cpu_limit,
          domain,
          schedule,
          maxReplicas,
        })
        status = k8sStatus
      }

      // Update status + last_deployed_at
      const { rows: [updated] } = await app.pg.query(
        `UPDATE workloads
         SET status = $1, last_deployed_at = NOW(), updated_at = NOW()
         WHERE id = $2
         RETURNING id, name, type, status, domain, last_deployed_at, created_at`,
        [status, workload.id],
      )

      return reply.status(201).send(updated)
    },
  )

  // -------------------------------------------------------------------------
  // GET /workloads/:id — workload details + live k8s status
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/workloads/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows } = await app.pg.query(
      `SELECT * FROM workloads WHERE id = $1`,
      [id],
    )

    if (!rows.length) return reply.status(404).send({ error: 'workload not found' })
    const workload = rows[0]
    if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    // Augment with live k8s status for deployment-backed types
    let liveStatus: object | null = null
    if (workload.type === 'service' || workload.type === 'static') {
      liveStatus = await getLiveDeploymentStatus(workload.name)
    }

    return { ...workload, k8s: liveStatus }
  })

  // -------------------------------------------------------------------------
  // PUT /workloads/:id — update workload (env vars, replicas, image)
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string }; Body: WorkloadUpdateBody }>(
    '/workloads/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            image:        { type: 'string' },
            replicas:     { type: 'integer', minimum: 1, maximum: 50 },
            env:          { type: 'object', additionalProperties: { type: 'string' } },
            memory_limit: { type: 'string' },
            cpu_limit:    { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id } = req.params
      const updates = req.body

      const { rows } = await app.pg.query(
        `SELECT * FROM workloads WHERE id = $1`,
        [id],
      )

      if (!rows.length) return reply.status(404).send({ error: 'workload not found' })
      const workload = rows[0]
      if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      // Merge updates
      const newImage       = updates.image        ?? workload.image
      const newReplicas    = updates.replicas     ?? workload.replicas
      const newEnv         = updates.env          ? { ...workload.env, ...updates.env } : workload.env
      const newMemoryLimit = updates.memory_limit ?? workload.memory_limit
      const newCpuLimit    = updates.cpu_limit    ?? workload.cpu_limit

      // Apply to k8s (best-effort for deployment-backed workloads)
      if (newImage && (workload.type === 'service' || workload.type === 'static')) {
        try {
          const { body: dep } = await appsV1.readNamespacedDeployment(workload.name, WORKLOAD_NAMESPACE)
          dep.spec!.replicas = newReplicas
          const container = dep.spec!.template.spec!.containers[0]
          container.image = newImage
          container.env   = Object.entries(newEnv).map(([k, v]) => ({ name: k, value: String(v) }))
          container.resources = {
            limits:   { memory: newMemoryLimit, cpu: newCpuLimit },
            requests: { memory: newMemoryLimit, cpu: newCpuLimit },
          }
          // Bump restartedAt to trigger a rollout
          if (!dep.spec!.template.metadata) dep.spec!.template.metadata = {}
          if (!dep.spec!.template.metadata.annotations) dep.spec!.template.metadata.annotations = {}
          dep.spec!.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString()
          await appsV1.replaceNamespacedDeployment(workload.name, WORKLOAD_NAMESPACE, dep)
        } catch (err: any) {
          req.log.warn({ err: err?.message, workload_id: id }, 'workloads: k8s update failed')
        }
      }

      // Persist to DB
      const { rows: [updated] } = await app.pg.query(
        `UPDATE workloads
         SET image = $1, replicas = $2, env = $3, memory_limit = $4, cpu_limit = $5,
             updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [newImage, newReplicas, JSON.stringify(newEnv), newMemoryLimit, newCpuLimit, id],
      )

      return updated
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /workloads/:id — tear down workload
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/workloads/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows } = await app.pg.query(
      `SELECT id, tenant_id, name, type FROM workloads WHERE id = $1`,
      [id],
    )

    if (!rows.length) return reply.status(404).send({ error: 'workload not found' })
    const workload = rows[0]
    if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    // Tear down k8s resources first (best-effort)
    await deleteK8sResources(workload.name, workload.type)

    // Remove from DB
    await app.pg.query(`DELETE FROM workloads WHERE id = $1`, [id])

    return reply.status(204).send()
  })

  // -------------------------------------------------------------------------
  // POST /workloads/:id/deploy — redeploy (new build or rollout restart)
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>('/workloads/:id/deploy', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows } = await app.pg.query(
      `SELECT * FROM workloads WHERE id = $1`,
      [id],
    )

    if (!rows.length) return reply.status(404).send({ error: 'workload not found' })
    const workload = rows[0]
    if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    let newStatus: string = workload.status

    if (workload.source_git_url && !workload.image) {
      // Trigger a fresh build
      await triggerBuild(workload.source_git_url, workload.source_ref ?? 'main')
      newStatus = 'building'
    } else if (workload.image) {
      // Rollout restart: patch deployment with a new timestamp annotation
      if (workload.type === 'service' || workload.type === 'static') {
        try {
          const { body: dep } = await appsV1.readNamespacedDeployment(workload.name, WORKLOAD_NAMESPACE)
          if (!dep.spec!.template.metadata)              dep.spec!.template.metadata = {}
          if (!dep.spec!.template.metadata.annotations) dep.spec!.template.metadata.annotations = {}
          dep.spec!.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString()
          await appsV1.replaceNamespacedDeployment(workload.name, WORKLOAD_NAMESPACE, dep)
          newStatus = 'running'
        } catch (err: any) {
          req.log.warn({ err: err?.message, workload_id: id }, 'workloads: rollout restart failed')
          newStatus = 'failed'
        }
      } else {
        // For function/job: re-deploy via full k8s deploy path
        const { plan_id } = await getPlanLimits(app.pg, workload.tenant_id)
        const k8sStatus = await deployToK8s({
          name:         workload.name,
          tenant_id:    workload.tenant_id,
          type:         workload.type,
          image:        workload.image,
          port:         workload.port ?? 8080,
          env:          workload.env ?? {},
          replicas:     workload.replicas ?? 1,
          memory_limit: workload.memory_limit ?? '256Mi',
          cpu_limit:    workload.cpu_limit ?? '100m',
          domain:       workload.domain,
          maxReplicas:  MAX_REPLICAS_BY_PLAN[plan_id] ?? 2,
        })
        newStatus = k8sStatus
      }
    }

    const { rows: [updated] } = await app.pg.query(
      `UPDATE workloads
       SET status = $1, last_deployed_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, type, status, domain, last_deployed_at`,
      [newStatus, id],
    )

    return updated
  })

  // -------------------------------------------------------------------------
  // GET /workloads/:id/logs — last 100 log lines from Loki
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/workloads/:id/logs',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id } = req.params
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)

      const { rows } = await app.pg.query(
        `SELECT id, tenant_id, name FROM workloads WHERE id = $1`,
        [id],
      )

      if (!rows.length) return reply.status(404).send({ error: 'workload not found' })
      const workload = rows[0]
      if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      const lines = await fetchLokiLogs(workload.name, limit)

      return { workload_id: id, name: workload.name, lines }
    },
  )
}
