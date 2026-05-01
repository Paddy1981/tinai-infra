import { FastifyInstance } from 'fastify'
import * as k8s from '@kubernetes/client-node'
import { PassThrough } from 'stream'
import { randomBytes } from 'crypto'
import { loadConfig } from '../config'
import { requirePlan } from '../middleware/planGate'
import { provisionNamespace } from './provisioner'

const cfg = loadConfig()

const kc = new k8s.KubeConfig()
try {
  kc.loadFromCluster()
} catch {
  kc.loadFromDefault()
}
const appsV1 = kc.makeApiClient(k8s.AppsV1Api)
const batchV1 = kc.makeApiClient(k8s.BatchV1Api)
const coreV1 = kc.makeApiClient(k8s.CoreV1Api)
const networkingV1 = kc.makeApiClient(k8s.NetworkingV1Api)
const logApi = new k8s.Log(kc)

const PG_HOST = process.env.PG_HOST ?? 'postgresql.tinai-system.svc.cluster.local'
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'https://minio.tinai.cloud'
const APPS_NAMESPACE = process.env.APPS_NAMESPACE ?? 'tinai-apps'
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? 'tinai.cloud'
const REGISTRY = process.env.CONTAINER_REGISTRY ?? 'registry.tinai.cloud'

// ---------------------------------------------------------------------------
// Environment-aware helpers
// ---------------------------------------------------------------------------

type Environment = 'production' | 'staging' | 'development'

const VALID_ENVIRONMENTS: Environment[] = ['production', 'staging', 'development']

/** Compute the K8s namespace for a given environment */
function namespaceForEnv(env: Environment): string {
  switch (env) {
    case 'production':  return APPS_NAMESPACE
    case 'staging':     return process.env.STAGING_NAMESPACE ?? 'tinai-staging'
    case 'development': return process.env.DEV_NAMESPACE ?? 'tinai-dev'
  }
}

/** Compute the K8s deployment name: <app>-<env> (production omits suffix) */
function deploymentName(appName: string, env: Environment): string {
  return env === 'production' ? appName : `${appName}-${env}`
}

/** Compute environment-specific domain: staging gets staging-<app>.tinai.cloud */
function domainForEnv(appName: string, env: Environment): string {
  switch (env) {
    case 'production':  return `${appName}.${PLATFORM_DOMAIN}`
    case 'staging':     return `staging-${appName}.${PLATFORM_DOMAIN}`
    case 'development': return `dev-${appName}.${PLATFORM_DOMAIN}`
  }
}

/** Return the NODE_ENV value for a deployment environment */
function nodeEnvForEnv(env: Environment): string {
  switch (env) {
    case 'production':  return 'production'
    case 'staging':     return 'staging'
    case 'development': return 'development'
  }
}

/** Build the set of auto-injected env vars for a deployment */
function autoInjectedEnvVars(
  appName: string,
  env: Environment,
  dbUrl?: string,
): Record<string, string> {
  const domain = domainForEnv(appName, env)
  return {
    NODE_ENV: nodeEnvForEnv(env),
    TINAI_ENVIRONMENT: env,
    TINAI_APP_NAME: appName,
    TINAI_APP_URL: `https://${domain}`,
    ...(dbUrl ? { DATABASE_URL: dbUrl } : {}),
  }
}

/**
 * Auto-provision all resources required by a newly created app:
 *   1. PostgreSQL database + app_databases record
 *   2. MinIO storage bucket entry in storage_buckets
 *   3. K8s Secret with DATABASE_URL in tinai-apps namespace
 *   4. custom_domains record: <app-name>.tinai.cloud (verified=true)
 *
 * Each step is best-effort — failures are logged but do not block app creation.
 * Returns a summary of what was provisioned.
 */
async function autoProvisionResources(
  pg: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  appName: string,
  tenantId: string,
  log: { info: Function; warn: Function; error: Function },
): Promise<{ provisioned: string[]; errors: string[] }> {
  const provisioned: string[] = []
  const errors: string[] = []

  const slug = appName.replace(/-/g, '_')
  const dbName = `tinai_${slug}`
  const dbUser = `tinai_${slug}`
  const dbPassword = randomBytes(18).toString('base64url')
  const connectionString = `postgresql://${dbUser}:${dbPassword}@${PG_HOST}:5432/${dbName}`

  // ── 1. Create PostgreSQL database via pg query ─────────────────────────
  try {
    // CREATE DATABASE cannot run inside a transaction, use a separate connection.
    // The platform pg pool is connected to the admin database so DDL is allowed.
    // We use IF NOT EXISTS-style guard: catch duplicate_database (42P04) errors.
    await pg.query(`CREATE DATABASE "${dbName}"`)
    await pg.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${dbUser}') THEN
        CREATE ROLE "${dbUser}" LOGIN PASSWORD '${dbPassword}';
      END IF;
    END $$`)
    await pg.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}"`)
    provisioned.push('database_created')
  } catch (err: any) {
    if (err.code === '42P04') {
      // duplicate_database — already exists, not an error
      provisioned.push('database_already_exists')
    } else {
      log.warn({ msg: 'auto-provision: database creation failed', err: err.message, appName })
      errors.push(`database: ${err.message}`)
    }
  }

  // ── 2. Insert into app_databases table ─────────────────────────────────
  try {
    const { rows: existing } = await pg.query(
      'SELECT id FROM app_databases WHERE app_name = $1', [appName],
    )
    if (!existing.length) {
      await pg.query(
        `INSERT INTO app_databases (app_name, db_name, host, port, username, password_hash, status)
         VALUES ($1, $2, $3, 5432, $4, $5, 'active')`,
        [appName, dbName, PG_HOST, dbUser, `provisioned:${Date.now()}`],
      )
      provisioned.push('app_databases_record')
    } else {
      provisioned.push('app_databases_record_exists')
    }
  } catch (err: any) {
    log.warn({ msg: 'auto-provision: app_databases insert failed', err: err.message, appName })
    errors.push(`app_databases: ${err.message}`)
  }

  // ── 3. Create storage bucket entry in storage_buckets ──────────────────
  try {
    const bucketName = `${appName}-assets`
    const { rows: existing } = await pg.query(
      'SELECT id FROM storage_buckets WHERE tenant_id = $1 AND name = $2', [tenantId, bucketName],
    )
    if (!existing.length) {
      await pg.query(
        `INSERT INTO storage_buckets (tenant_id, name, region, quota_gb, status, endpoint_url)
         VALUES ($1, $2, 'in', 10, 'active', $3)`,
        [tenantId, bucketName, MINIO_ENDPOINT],
      )
      provisioned.push('storage_bucket')
    } else {
      provisioned.push('storage_bucket_exists')
    }
  } catch (err: any) {
    log.warn({ msg: 'auto-provision: storage bucket insert failed', err: err.message, appName })
    errors.push(`storage_bucket: ${err.message}`)
  }

  // ── 4. Create K8s Secret with DATABASE_URL in tinai-apps namespace ─────
  try {
    const secretName = `${appName}-db-credentials`
    try {
      await coreV1.readNamespacedSecret(secretName, APPS_NAMESPACE)
      provisioned.push('k8s_secret_exists')
    } catch {
      await coreV1.createNamespacedSecret(APPS_NAMESPACE, {
        metadata: {
          name: secretName,
          namespace: APPS_NAMESPACE,
          labels: {
            'tinai.cloud/app': appName,
            'tinai.cloud/managed-by': 'tinai-infra',
            'tinai.cloud/tenant-id': tenantId,
          },
        },
        type: 'Opaque',
        stringData: {
          DATABASE_URL: connectionString,
          DB_HOST: PG_HOST,
          DB_PORT: '5432',
          DB_NAME: dbName,
          DB_USER: dbUser,
          DB_PASSWORD: dbPassword,
        },
      })
      provisioned.push('k8s_secret')
    }
  } catch (err: any) {
    log.warn({ msg: 'auto-provision: K8s secret creation failed', err: err.message, appName })
    errors.push(`k8s_secret: ${err.message}`)
  }

  // ── 5. Insert custom_domains record: <app-name>.tinai.cloud ────────────
  try {
    const domain = `${appName}.tinai.cloud`
    const { rows: existing } = await pg.query(
      'SELECT id FROM custom_domains WHERE domain = $1', [domain],
    )
    if (!existing.length) {
      await pg.query(
        `INSERT INTO custom_domains (app_name, domain, verified, cert_status)
         VALUES ($1, $2, true, 'issued')`,
        [appName, domain],
      )
      provisioned.push('custom_domain')
    } else {
      provisioned.push('custom_domain_exists')
    }
  } catch (err: any) {
    log.warn({ msg: 'auto-provision: custom domain insert failed', err: err.message, appName })
    errors.push(`custom_domain: ${err.message}`)
  }

  log.info({ appName, tenantId, provisioned, errors }, 'auto-provision complete')
  return { provisioned, errors }
}

async function getDeploymentStatus(name: string, namespace?: string) {
  try {
    const ns = namespace ?? cfg.stagingNamespace
    const { body: dep } = await appsV1.readNamespacedDeployment(name, ns)
    const desired = dep.spec?.replicas ?? 1
    const ready = dep.status?.readyReplicas ?? 0
    return {
      image: dep.spec?.template?.spec?.containers?.[0]?.image ?? null,
      replicas: desired,
      ready_replicas: ready,
      status: ready >= desired ? 'running' : 'deploying',
    }
  } catch {
    return null
  }
}

/**
 * Get deployment status for all environments of an app.
 */
async function getEnvironmentDeployments(appName: string) {
  const result: Record<string, any> = {}
  for (const env of VALID_ENVIRONMENTS) {
    const depName = deploymentName(appName, env)
    const ns = namespaceForEnv(env)
    const status = await getDeploymentStatus(depName, ns)
    if (status) {
      result[env] = { ...status, domain: domainForEnv(appName, env) }
    }
  }
  return result
}

/**
 * Create or update a K8s Deployment for a specific app environment.
 */
async function upsertK8sDeployment(
  appName: string,
  env: Environment,
  image: string,
  envVars: Record<string, string>,
  log: { info: Function; warn: Function; error: Function },
): Promise<{ action: 'created' | 'updated'; deployment_name: string; namespace: string }> {
  const depName = deploymentName(appName, env)
  const ns = namespaceForEnv(env)

  // Merge auto-injected vars with user-supplied vars (auto-injected take precedence for system keys)
  const containerEnv: k8s.V1EnvVar[] = Object.entries(envVars).map(([name, value]) => ({
    name,
    value,
  }))

  const deploymentSpec: k8s.V1Deployment = {
    metadata: {
      name: depName,
      namespace: ns,
      labels: {
        'tinai.cloud/app': appName,
        'tinai.cloud/environment': env,
        'tinai.cloud/managed-by': 'tinai-api',
      },
    },
    spec: {
      replicas: env === 'production' ? 2 : 1,
      selector: { matchLabels: { 'tinai.cloud/app': appName, 'tinai.cloud/environment': env } },
      template: {
        metadata: {
          labels: {
            'tinai.cloud/app': appName,
            'tinai.cloud/environment': env,
          },
          annotations: {
            'tinai.cloud/deployed-at': new Date().toISOString(),
          },
        },
        spec: {
          containers: [
            {
              name: appName,
              image,
              ports: [{ containerPort: 3000 }],
              env: containerEnv,
              envFrom: [
                {
                  secretRef: {
                    name: `${appName}-db-credentials`,
                    optional: true,
                  },
                },
                {
                  configMapRef: {
                    name: `${depName}-env`,
                    optional: true,
                  },
                },
              ],
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: env === 'production' ? '1000m' : '500m', memory: env === 'production' ? '512Mi' : '256Mi' },
              },
            },
          ],
          imagePullSecrets: [{ name: 'registry-credentials' }],
        },
      },
    },
  }

  try {
    await appsV1.readNamespacedDeployment(depName, ns)
    // Deployment exists — patch it
    await appsV1.replaceNamespacedDeployment(depName, ns, deploymentSpec)
    log.info({ depName, ns, image }, 'deployment updated')
    return { action: 'updated', deployment_name: depName, namespace: ns }
  } catch {
    // Deployment does not exist — create it
    await appsV1.createNamespacedDeployment(ns, deploymentSpec)
    log.info({ depName, ns, image }, 'deployment created')
    return { action: 'created', deployment_name: depName, namespace: ns }
  }
}

/**
 * Create or update an Ingress resource for an app environment.
 */
async function upsertIngress(
  appName: string,
  env: Environment,
  log: { info: Function; warn: Function; error: Function },
): Promise<void> {
  const depName = deploymentName(appName, env)
  const ns = namespaceForEnv(env)
  const host = domainForEnv(appName, env)
  const ingressName = `${depName}-ingress`

  const ingressSpec: k8s.V1Ingress = {
    metadata: {
      name: ingressName,
      namespace: ns,
      labels: {
        'tinai.cloud/app': appName,
        'tinai.cloud/environment': env,
      },
      annotations: {
        'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        'nginx.ingress.kubernetes.io/proxy-body-size': '50m',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      tls: [{ hosts: [host], secretName: `${depName}-tls` }],
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: depName,
                    port: { number: 3000 },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  }

  try {
    await networkingV1.readNamespacedIngress(ingressName, ns)
    await networkingV1.replaceNamespacedIngress(ingressName, ns, ingressSpec)
    log.info({ ingressName, ns, host }, 'ingress updated')
  } catch {
    await networkingV1.createNamespacedIngress(ns, ingressSpec)
    log.info({ ingressName, ns, host }, 'ingress created')
  }
}

async function getRecentBuilds(appName: string) {
  try {
    const { body } = await batchV1.listNamespacedJob(
      cfg.buildNamespace,
      undefined, undefined, undefined, undefined,
      `tinai.cloud/app=${appName}`,
    )
    return (body.items ?? [])
      .sort(
        (a, b) =>
          new Date(b.metadata?.creationTimestamp ?? 0).getTime() -
          new Date(a.metadata?.creationTimestamp ?? 0).getTime(),
      )
      .slice(0, 10)
      .map(j => ({
        name: j.metadata?.name,
        commit: j.metadata?.labels?.['tinai.cloud/commit'],
        start_time: j.status?.startTime ?? null,
        completion_time: j.status?.completionTime ?? null,
        status: (j.status?.succeeded ?? 0) > 0 ? 'succeeded' : (j.status?.failed ?? 0) > 0 ? 'failed' : 'running',
      }))
  } catch {
    return []
  }
}

interface AppBody {
  name: string
  repoFullName?: string
  createRepo?: boolean
  owner?: string
  framework?: 'nextjs' | 'node' | 'static' | 'go'
  projectId?: string
  environment?: Environment
}

interface DeployBody {
  environment: Environment
  image?: string
  branch?: string
}

interface PromoteBody {
  from: 'staging' | 'development'
  to: 'production' | 'staging'
}

interface EnvVarsBody {
  vars: Record<string, string>
}

export async function appsRoutes(app: FastifyInstance) {
  // List only the caller's own apps — includes environment info and per-env deployment status
  app.get('/apps', async (req) => {
    const tenantId = (req as any).tenantId as string
    const { rows } = await app.pg.query(
      `SELECT a.*, p.name AS project_name, p.slug AS project_slug
       FROM apps a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE a.owner = $1
       ORDER BY a.created_at DESC`,
      [tenantId],
    )
    const apps = await Promise.all(
      rows.map(async row => {
        const environments = await getEnvironmentDeployments(row.name)
        return {
          ...row,
          domain: row.domain ?? domainForEnv(row.name, row.environment ?? 'production'),
          deployment: await getDeploymentStatus(
            deploymentName(row.name, row.environment ?? 'production'),
            namespaceForEnv(row.environment ?? 'production'),
          ),
          environments,
        }
      }),
    )
    return apps
  })

  // Register a new app — owner is always set from the JWT, never from the request body
  // If createRepo=true, auto-creates a Forgejo repo and registers the build webhook
  app.post<{ Body: AppBody }>('/apps', {
    preHandler: requirePlan('workloads'),
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          repoFullName: { type: 'string' },
          createRepo: { type: 'boolean' },
          owner: { type: 'string' },
          framework: { type: 'string', enum: ['nextjs', 'node', 'static', 'go'] },
        },
      },
    },
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name, createRepo } = req.body
    let repoFullName = req.body.repoFullName || ''

    // Auto-create a Forgejo repo if requested
    if (createRepo) {
      const forgejoUrl = process.env.FORGEJO_URL || 'http://gitea.forgejo.svc.cluster.local:3000'
      const adminToken = process.env.FORGEJO_ADMIN_TOKEN || ''
      const webhookUrl = process.env.FORGEJO_WEBHOOK_URL || 'http://build-api.tinai-system.svc.cluster.local:8080/webhook'
      const webhookSecret = process.env.FORGEJO_WEBHOOK_SECRET || ''

      if (!adminToken) {
        return reply.status(503).send({ error: 'Git service not configured on this cluster' })
      }

      try {
        // Try to create org for tenant, fall back to admin user's personal repos
        let orgOwner = tenantId
        let hasOrg = false
        const orgCheck = await fetch(`${forgejoUrl}/api/v1/orgs/${tenantId}`, {
          headers: { 'Authorization': `token ${adminToken}` },
        })
        if (orgCheck.ok) {
          hasOrg = true
        } else {
          // Try creating the org
          const orgCreate = await fetch(`${forgejoUrl}/api/v1/orgs`, {
            method: 'POST',
            headers: { 'Authorization': `token ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: tenantId, full_name: tenantId, visibility: 'private' }),
          })
          if (orgCreate.ok) {
            hasOrg = true
          } else if (orgCreate.status === 422) {
            // 422 = name conflict — could be existing org OR existing user with same name
            // Re-verify if it's actually an org
            const recheck = await fetch(`${forgejoUrl}/api/v1/orgs/${tenantId}`, {
              headers: { 'Authorization': `token ${adminToken}` },
            })
            hasOrg = recheck.ok
            if (!hasOrg) orgOwner = 'tinai-admin'
          } else {
            orgOwner = 'tinai-admin'
            hasOrg = false
          }
        }

        // Create the repo — use org endpoint only if tenant has a real Forgejo org
        const repoEndpoint = hasOrg
          ? `${forgejoUrl}/api/v1/orgs/${orgOwner}/repos`
          : `${forgejoUrl}/api/v1/user/repos`

        const repoRes = await fetch(repoEndpoint, {
          method: 'POST',
          headers: { 'Authorization': `token ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            description: `App: ${name} — created from tinai.cloud`,
            auto_init: true,
            default_branch: 'main',
            private: false,
          }),
        })

        if (!repoRes.ok && repoRes.status !== 409) {
          const err = await repoRes.json().catch(() => ({}))
          return reply.status(502).send({
            error: 'Failed to create repo in Forgejo',
            detail: (err as any)?.message ?? `status ${repoRes.status}`,
          })
        }

        const repo = repoRes.status === 409
          ? { full_name: `${orgOwner}/${name}` }
          : await repoRes.json() as any

        repoFullName = repo.full_name

        // Register webhook for the build pipeline
        if (webhookSecret) {
          try {
            await fetch(`${forgejoUrl}/api/v1/repos/${repoFullName}/hooks`, {
              method: 'POST',
              headers: { 'Authorization': `token ${adminToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'gitea',
                active: true,
                config: { url: webhookUrl, content_type: 'json', secret: webhookSecret },
                events: ['push', 'pull_request'],
              }),
            })
            app.log.info({ msg: 'webhook registered', repo: repoFullName })
          } catch (hookErr: any) {
            app.log.warn({ msg: 'webhook registration failed', repo: repoFullName, err: hookErr.message })
          }
        }
      } catch (err: any) {
        app.log.error({ msg: 'repo creation failed', err: err.message })
        return reply.status(502).send({ error: 'Git service error', detail: err.message })
      }
    }

    if (!repoFullName) {
      return reply.status(400).send({ error: 'repoFullName is required (or set createRepo=true)' })
    }

    // Auto-provision the staging namespace with registry secrets, network policies, etc.
    // This is idempotent — safe to call on every app creation.
    try {
      await provisionNamespace(cfg.stagingNamespace, tenantId, 'starter', app.log)
    } catch (provErr: any) {
      app.log.warn({ msg: 'namespace provisioning warning (non-fatal)', err: provErr.message })
    }

    // owner is always derived from the authenticated caller — never from req.body
    const framework = req.body.framework ?? null
    const projectId = req.body.projectId ?? null
    const environment = req.body.environment ?? 'production'
    const domain = domainForEnv(name, environment as Environment)
    const { rows } = await app.pg.query(
      `INSERT INTO apps (name, owner, repo_full_name, framework, project_id, environment, domain)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, tenantId, repoFullName, framework, projectId, environment, domain],
    )

    // Auto-provision all required resources (DB, bucket, domain, K8s secrets).
    // Runs best-effort — app creation succeeds even if some provisioning steps fail.
    let provisionResult: { provisioned: string[]; errors: string[] } = { provisioned: [], errors: [] }
    try {
      provisionResult = await autoProvisionResources(app.pg, name, tenantId, app.log)
    } catch (provErr: any) {
      app.log.warn({ msg: 'auto-provision failed (non-fatal)', err: provErr.message, app: name })
    }

    return reply.status(201).send({
      ...rows[0],
      framework: req.body.framework ?? null,
      provisioning: provisionResult,
      domain: `${name}.tinai.cloud`,
    })
  })

  // Get app details — enforce ownership, includes per-environment deployment status
  app.get<{ Params: { name: string } }>('/apps/:name', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { rows } = await app.pg.query(
      `SELECT a.*, p.name AS project_name, p.slug AS project_slug
       FROM apps a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE a.name = $1`,
      [req.params.name],
    )
    if (!rows.length) return reply.status(404).send({ error: 'not found' })
    if (rows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const appRow = rows[0]
    const env = (appRow.environment ?? 'production') as Environment

    const [deployment, recentBuilds, environments] = await Promise.all([
      getDeploymentStatus(deploymentName(appRow.name, env), namespaceForEnv(env)),
      getRecentBuilds(appRow.name),
      getEnvironmentDeployments(appRow.name),
    ])

    // Fetch recent deployment history from app_deployments table
    const { rows: deploymentHistory } = await app.pg.query(
      `SELECT * FROM app_deployments WHERE app_name = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.name],
    ).catch(() => ({ rows: [] }))

    return {
      ...appRow,
      domain: appRow.domain ?? domainForEnv(appRow.name, env),
      deployment,
      recent_builds: recentBuilds,
      environments,
      deployment_history: deploymentHistory,
    }
  })

  // Delete an app — enforce ownership
  app.delete<{ Params: { name: string } }>('/apps/:name', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { rows: existing } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1',
      [req.params.name],
    )
    if (!existing.length) return reply.status(404).send({ error: 'not found' })
    if (existing[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    await app.pg.query('DELETE FROM apps WHERE name = $1', [req.params.name])
    return reply.status(204).send()
  })

  // Stream pod logs — enforce ownership
  app.get<{
    Params: { name: string }
    Querystring: { follow?: string; tail?: string }
  }>('/apps/:name/logs', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params

    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1',
      [name],
    )
    if (!appRows.length) return reply.status(404).send({ error: 'not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const follow = req.query.follow === 'true'
    const tailLines = parseInt(req.query.tail ?? '100')

    const { body: podList } = await coreV1.listNamespacedPod(
      cfg.stagingNamespace, undefined, undefined, undefined, undefined,
      `tinai.cloud/app=${name}`,
    )
    const pod = podList.items[0]
    if (!pod) return reply.status(404).send({ error: 'no pod found' })

    const podName = pod.metadata!.name!
    const stream = new PassThrough()
    reply.type('text/plain')

    logApi.log(cfg.stagingNamespace, podName, name, stream, {
      follow,
      tailLines,
      pretty: false,
      timestamps: true,
    }).then(() => stream.end()).catch(() => stream.end())

    return reply.send(stream)
  })

  // SSE log stream — enforce ownership
  app.get<{
    Params: { name: string }
    Querystring: { tail?: string }
  }>('/apps/:name/logs/stream', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params

    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1',
      [name],
    )
    if (!appRows.length) return reply.status(404).send({ error: 'not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const tailLines = parseInt(req.query.tail ?? '100')

    const { body: podList } = await coreV1.listNamespacedPod(
      cfg.stagingNamespace, undefined, undefined, undefined, undefined,
      `tinai.cloud/app=${name}`,
    )
    const pod = podList.items[0]
    if (!pod) return reply.status(404).send({ error: 'no pod found' })

    const podName = pod.metadata!.name!

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const sendEvent = (data: object) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    // Heartbeat every 15s
    const heartbeatInterval = setInterval(() => {
      reply.raw.write(': heartbeat\n\n')
    }, 15_000)

    const logStream = new PassThrough()

    let buffer = ''
    logStream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        // Lines from K8s with timestamps look like: "2024-01-01T00:00:00Z <message>"
        const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/)
        const timestamp = tsMatch ? tsMatch[1] : new Date().toISOString()
        const message = tsMatch ? tsMatch[2] : line

        // Detect log level from common patterns
        let level = 'info'
        const msgLower = message.toLowerCase()
        if (msgLower.includes('error') || msgLower.includes('err ') || msgLower.includes('fatal')) level = 'error'
        else if (msgLower.includes('warn')) level = 'warn'

        sendEvent({ timestamp, level, message, pod: podName })
      }
    })

    logStream.on('end', () => {
      clearInterval(heartbeatInterval)
      reply.raw.end()
    })

    logStream.on('error', () => {
      clearInterval(heartbeatInterval)
      reply.raw.end()
    })

    req.raw.on('close', () => {
      clearInterval(heartbeatInterval)
      logStream.destroy()
    })

    logApi.log(cfg.stagingNamespace, podName, name, logStream, {
      follow: true,
      tailLines,
      pretty: false,
      timestamps: true,
    }).catch(() => logStream.destroy())

    // Return the raw response — Fastify must not process further
    return reply
  })

  // Get env vars (ConfigMap) — enforce ownership
  app.get<{ Params: { name: string } }>('/apps/:name/env', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1',
      [req.params.name],
    )
    if (!appRows.length) return reply.status(404).send({ error: 'not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    try {
      const { body: cm } = await coreV1.readNamespacedConfigMap(`${req.params.name}-env`, cfg.stagingNamespace)
      return cm.data ?? {}
    } catch {
      return {}
    }
  })

  // Set env vars (upsert ConfigMap, restart deployment) — enforce ownership
  app.post<{ Params: { name: string }; Body: Record<string, string> }>('/apps/:name/env', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params

    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1',
      [name],
    )
    if (!appRows.length) return reply.status(404).send({ error: 'not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const cmName = `${name}-env`

    try {
      const { body: existing } = await coreV1.readNamespacedConfigMap(cmName, cfg.stagingNamespace)
      existing.data = { ...(existing.data ?? {}), ...req.body }
      await coreV1.replaceNamespacedConfigMap(cmName, cfg.stagingNamespace, existing)
    } catch {
      await coreV1.createNamespacedConfigMap(cfg.stagingNamespace, {
        metadata: { name: cmName, namespace: cfg.stagingNamespace },
        data: req.body,
      })
    }

    // Restart deployment to pick up new env vars
    try {
      const { body: dep } = await appsV1.readNamespacedDeployment(name, cfg.stagingNamespace)
      if (!dep.spec!.template!.metadata) dep.spec!.template!.metadata = {}
      if (!dep.spec!.template!.metadata.annotations) dep.spec!.template!.metadata.annotations = {}
      dep.spec!.template!.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString()
      await appsV1.replaceNamespacedDeployment(name, cfg.stagingNamespace, dep)
    } catch { /* no deployment yet, env will be picked up when app deploys */ }

    return { ok: true }
  })

  // Delete one env var — enforce ownership
  app.delete<{ Params: { name: string; key: string } }>('/apps/:name/env/:key', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name, key } = req.params

    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1',
      [name],
    )
    if (!appRows.length) return reply.status(404).send({ error: 'not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const cmName = `${name}-env`

    try {
      const { body: existing } = await coreV1.readNamespacedConfigMap(cmName, cfg.stagingNamespace)
      if (existing.data) {
        delete existing.data[key]
        await coreV1.replaceNamespacedConfigMap(cmName, cfg.stagingNamespace, existing)
      }
    } catch {
      return reply.status(404).send({ error: 'env not found' })
    }

    return reply.status(204).send()
  })

  // Get webhook URL and secret — enforce ownership, auto-generate secret if missing
  app.get<{ Params: { name: string } }>('/apps/:name/webhook-config', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params

    const { rows } = await app.pg.query(
      'SELECT owner, webhook_secret FROM apps WHERE name = $1',
      [name],
    )
    if (!rows.length) return reply.status(404).send({ error: 'not found' })
    if (rows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    let secret = rows[0].webhook_secret
    if (!secret) {
      const { randomBytes } = await import('crypto')
      secret = randomBytes(24).toString('hex')
      await app.pg.query('UPDATE apps SET webhook_secret = $1 WHERE name = $2', [secret, name])
    }

    const apiBase = process.env.API_PUBLIC_URL ?? 'https://api.tinai.cloud'
    return {
      webhook_url: `${apiBase}/api/v1/apps/${name}/deploy`,
      webhook_secret: secret,
      instructions: [
        `In your Forgejo repo → Settings → Webhooks → Add webhook`,
        `URL: ${apiBase}/api/v1/apps/${name}/deploy`,
        `Secret: (shown above)`,
        `Content type: application/json`,
        `Events: Push events`,
      ],
    }
  })

  // Rotate the webhook secret — enforce ownership
  app.post<{ Params: { name: string } }>('/apps/:name/webhook/rotate', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params

    const { rows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [name],
    )
    if (!rows.length) return reply.status(404).send({ error: 'not found' })
    if (rows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { randomBytes } = await import('crypto')
    const secret = randomBytes(24).toString('hex')
    await app.pg.query('UPDATE apps SET webhook_secret = $1 WHERE name = $2', [secret, name])

    const apiBase = process.env.API_PUBLIC_URL ?? 'https://api.tinai.cloud'
    return {
      webhook_url: `${apiBase}/api/v1/apps/${name}/deploy`,
      webhook_secret: secret,
    }
  })

  // ── Environment-aware deployment route ────────────────────────────────────
  // POST /apps/:name/deploy/env — create or update a K8s deployment for a specific environment
  app.post<{ Params: { name: string }; Body: DeployBody }>('/apps/:name/deploy/env', {
    preHandler: requirePlan('workloads'),
    schema: {
      body: {
        type: 'object',
        required: ['environment'],
        properties: {
          environment: { type: 'string', enum: ['production', 'staging', 'development'] },
          image: { type: 'string' },
          branch: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params
    const { environment: env, image: requestedImage, branch } = req.body

    // Verify ownership
    const { rows: appRows } = await app.pg.query(
      'SELECT * FROM apps WHERE name = $1', [name],
    )
    if (!appRows.length) return reply.status(404).send({ error: 'not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const appRow = appRows[0]

    // Determine the image to deploy
    const image = requestedImage
      ?? `${REGISTRY}/${appRow.repo_full_name}:${branch ?? 'latest'}`

    // Gather user-defined per-environment vars
    const { rows: envVarRows } = await app.pg.query(
      'SELECT key, value FROM app_env_vars WHERE app_name = $1 AND environment = $2',
      [name, env],
    )
    const userVars: Record<string, string> = {}
    for (const row of envVarRows) {
      userVars[row.key] = row.value
    }

    // Fetch DATABASE_URL from the app's db credentials secret if it exists
    let dbUrl: string | undefined
    try {
      const { body: secret } = await coreV1.readNamespacedSecret(`${name}-db-credentials`, APPS_NAMESPACE)
      if (secret.data?.DATABASE_URL) {
        dbUrl = Buffer.from(secret.data.DATABASE_URL, 'base64').toString()
      }
    } catch { /* no db secret */ }

    // Merge: user vars first, then auto-injected (auto-injected win on conflicts)
    const mergedVars = { ...userVars, ...autoInjectedEnvVars(name, env, dbUrl) }

    // Provision the namespace if it doesn't exist
    try {
      await provisionNamespace(namespaceForEnv(env), tenantId, 'starter', app.log)
    } catch (err: any) {
      app.log.warn({ msg: 'namespace provisioning warning', err: err.message })
    }

    // Upsert K8s Deployment
    const deployResult = await upsertK8sDeployment(name, env, image, mergedVars, app.log)

    // Upsert Ingress
    try {
      await upsertIngress(name, env, app.log)
    } catch (err: any) {
      app.log.warn({ msg: 'ingress upsert failed (non-fatal)', err: err.message })
    }

    // Record deployment in history table
    try {
      await app.pg.query(
        `INSERT INTO app_deployments (app_name, environment, image, branch, status, triggered_by)
         VALUES ($1, $2, $3, $4, 'deploying', $5)`,
        [name, env, image, branch ?? null, tenantId],
      )
    } catch (err: any) {
      app.log.warn({ msg: 'deployment history insert failed', err: err.message })
    }

    // Update the apps row with the domain for this environment
    try {
      await app.pg.query(
        'UPDATE apps SET domain = $1, environment = $2 WHERE name = $3',
        [domainForEnv(name, env), env, name],
      )
    } catch { /* non-fatal */ }

    return reply.status(200).send({
      ok: true,
      app: name,
      environment: env,
      image,
      domain: domainForEnv(name, env),
      namespace: deployResult.namespace,
      deployment_name: deployResult.deployment_name,
      action: deployResult.action,
      triggered_at: new Date().toISOString(),
    })
  })

  // ── Promote route ────────────────────────────────────────────────────────
  // POST /apps/:name/promote — copy an image from one environment to another
  app.post<{ Params: { name: string }; Body: PromoteBody }>('/apps/:name/promote', {
    preHandler: requirePlan('workloads'),
    schema: {
      body: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', enum: ['staging', 'development'] },
          to: { type: 'string', enum: ['production', 'staging'] },
        },
      },
    },
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params
    const { from, to } = req.body

    if (from === to) {
      return reply.status(400).send({ error: 'from and to environments must be different' })
    }

    // Verify ownership
    const { rows: appRows } = await app.pg.query(
      'SELECT * FROM apps WHERE name = $1', [name],
    )
    if (!appRows.length) return reply.status(404).send({ error: 'not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    // Read the source deployment to get its image
    const sourceDepName = deploymentName(name, from as Environment)
    const sourceNs = namespaceForEnv(from as Environment)

    let sourceImage: string
    try {
      const { body: sourceDep } = await appsV1.readNamespacedDeployment(sourceDepName, sourceNs)
      sourceImage = sourceDep.spec?.template?.spec?.containers?.[0]?.image ?? ''
      if (!sourceImage) {
        return reply.status(400).send({ error: `no image found in ${from} deployment` })
      }
    } catch {
      return reply.status(404).send({ error: `no ${from} deployment found for app ${name}` })
    }

    // Gather per-environment vars for the target
    const { rows: envVarRows } = await app.pg.query(
      'SELECT key, value FROM app_env_vars WHERE app_name = $1 AND environment = $2',
      [name, to],
    )
    const userVars: Record<string, string> = {}
    for (const row of envVarRows) {
      userVars[row.key] = row.value
    }

    let dbUrl: string | undefined
    try {
      const { body: secret } = await coreV1.readNamespacedSecret(`${name}-db-credentials`, APPS_NAMESPACE)
      if (secret.data?.DATABASE_URL) {
        dbUrl = Buffer.from(secret.data.DATABASE_URL, 'base64').toString()
      }
    } catch { /* no db secret */ }

    const mergedVars = { ...userVars, ...autoInjectedEnvVars(name, to as Environment, dbUrl) }

    // Provision target namespace
    try {
      await provisionNamespace(namespaceForEnv(to as Environment), tenantId, 'starter', app.log)
    } catch { /* non-fatal */ }

    // Deploy to target with the source image
    const deployResult = await upsertK8sDeployment(name, to as Environment, sourceImage, mergedVars, app.log)

    // Upsert Ingress for target
    try {
      await upsertIngress(name, to as Environment, app.log)
    } catch (err: any) {
      app.log.warn({ msg: 'ingress upsert during promote failed', err: err.message })
    }

    // Record in deployment history
    try {
      await app.pg.query(
        `INSERT INTO app_deployments (app_name, environment, image, status, triggered_by, promoted_from)
         VALUES ($1, $2, $3, 'deploying', $4, $5)`,
        [name, to, sourceImage, tenantId, from],
      )
    } catch { /* non-fatal */ }

    app.log.info({ app: name, from, to, image: sourceImage }, 'promotion triggered')

    return reply.status(200).send({
      ok: true,
      app: name,
      promoted_from: from,
      promoted_to: to,
      image: sourceImage,
      domain: domainForEnv(name, to as Environment),
      namespace: deployResult.namespace,
      deployment_name: deployResult.deployment_name,
      action: deployResult.action,
      triggered_at: new Date().toISOString(),
    })
  })

  // ── Per-environment env vars routes ──────────────────────────────────────
  // GET /apps/:name/env/:environment — list env vars for a specific environment
  app.get<{ Params: { name: string; environment: string } }>('/apps/:name/env/:environment', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name, environment: env } = req.params

    if (!VALID_ENVIRONMENTS.includes(env as Environment)) {
      return reply.status(400).send({ error: `invalid environment: ${env}` })
    }

    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [name],
    )
    if (!appRows.length) return reply.status(404).send({ error: 'not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    // Fetch user-defined env vars
    const { rows: envVarRows } = await app.pg.query(
      'SELECT key, value, is_secret, created_at, updated_at FROM app_env_vars WHERE app_name = $1 AND environment = $2 ORDER BY key',
      [name, env],
    )

    // Also show auto-injected vars (read-only)
    const autoVars = autoInjectedEnvVars(name, env as Environment)

    return {
      environment: env,
      user_vars: envVarRows.map(r => ({
        key: r.key,
        value: r.is_secret ? '********' : r.value,
        is_secret: r.is_secret,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      auto_injected: autoVars,
    }
  })

  // POST /apps/:name/env/:environment — set env vars for a specific environment
  app.post<{ Params: { name: string; environment: string }; Body: EnvVarsBody }>('/apps/:name/env/:environment', {
    schema: {
      body: {
        type: 'object',
        required: ['vars'],
        properties: {
          vars: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name, environment: env } = req.params

    if (!VALID_ENVIRONMENTS.includes(env as Environment)) {
      return reply.status(400).send({ error: `invalid environment: ${env}` })
    }

    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [name],
    )
    if (!appRows.length) return reply.status(404).send({ error: 'not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const vars = req.body.vars
    const keys = Object.keys(vars)

    // Upsert each variable
    for (const key of keys) {
      await app.pg.query(
        `INSERT INTO app_env_vars (app_name, environment, key, value, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (app_name, environment, key) DO UPDATE SET value = $4, updated_at = NOW()`,
        [name, env, key, vars[key]],
      )
    }

    // Also sync to K8s ConfigMap so running deployments can pick them up
    const depName = deploymentName(name, env as Environment)
    const ns = namespaceForEnv(env as Environment)
    const cmName = `${depName}-env`

    try {
      const { body: existing } = await coreV1.readNamespacedConfigMap(cmName, ns)
      existing.data = { ...(existing.data ?? {}), ...vars }
      await coreV1.replaceNamespacedConfigMap(cmName, ns, existing)
    } catch {
      await coreV1.createNamespacedConfigMap(ns, {
        metadata: { name: cmName, namespace: ns, labels: { 'tinai.cloud/app': name, 'tinai.cloud/environment': env } },
        data: vars,
      }).catch(() => { /* may fail if namespace doesn't exist yet */ })
    }

    // Restart the deployment to pick up new env vars
    try {
      const { body: dep } = await appsV1.readNamespacedDeployment(depName, ns)
      if (!dep.spec!.template!.metadata) dep.spec!.template!.metadata = {}
      if (!dep.spec!.template!.metadata.annotations) dep.spec!.template!.metadata.annotations = {}
      dep.spec!.template!.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString()
      await appsV1.replaceNamespacedDeployment(depName, ns, dep)
    } catch { /* no deployment yet */ }

    return { ok: true, environment: env, keys_set: keys }
  })

  // DELETE /apps/:name/env/:environment/:key — delete a single env var from a specific environment
  app.delete<{ Params: { name: string; environment: string; key: string } }>(
    '/apps/:name/env/:environment/:key',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { name, environment: env, key } = req.params

      if (!VALID_ENVIRONMENTS.includes(env as Environment)) {
        return reply.status(400).send({ error: `invalid environment: ${env}` })
      }

      const { rows: appRows } = await app.pg.query(
        'SELECT owner FROM apps WHERE name = $1', [name],
      )
      if (!appRows.length) return reply.status(404).send({ error: 'not found' })
      if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      const { rowCount } = await app.pg.query(
        'DELETE FROM app_env_vars WHERE app_name = $1 AND environment = $2 AND key = $3',
        [name, env, key],
      )
      if (!rowCount) return reply.status(404).send({ error: 'env var not found' })

      // Remove from K8s ConfigMap too
      const depName = deploymentName(name, env as Environment)
      const ns = namespaceForEnv(env as Environment)
      const cmName = `${depName}-env`

      try {
        const { body: existing } = await coreV1.readNamespacedConfigMap(cmName, ns)
        if (existing.data) {
          delete existing.data[key]
          await coreV1.replaceNamespacedConfigMap(cmName, ns, existing)
        }
      } catch { /* configmap may not exist */ }

      return reply.status(204).send()
    },
  )

  // Public deploy webhook — called by Forgejo push events
  // Verified by X-Tinai-Token header (the webhook_secret)
  app.post<{
    Params: { name: string }
    Headers: { 'x-tinai-token'?: string; 'x-hub-signature-256'?: string }
  }>('/apps/:name/deploy', {
    config: { skipAuth: true },
  } as any, async (req, reply) => {
    const { name } = req.params
    const token = req.headers['x-tinai-token'] as string | undefined

    const { rows } = await app.pg.query(
      'SELECT owner, webhook_secret FROM apps WHERE name = $1', [name],
    )
    if (!rows.length) return reply.status(404).send({ error: 'not found' })

    const expectedSecret = rows[0].webhook_secret
    if (!expectedSecret || !token) return reply.status(401).send({ error: 'missing token' })

    const { timingSafeEqual } = await import('crypto')
    const a = Buffer.from(token)
    const b = Buffer.from(expectedSecret)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.status(401).send({ error: 'invalid token' })
    }

    // Trigger a rolling restart of the deployment (build pipeline will pick this up)
    try {
      const { body: dep } = await appsV1.readNamespacedDeployment(name, cfg.stagingNamespace)
      if (!dep.spec!.template!.metadata) dep.spec!.template!.metadata = {}
      if (!dep.spec!.template!.metadata.annotations) dep.spec!.template!.metadata.annotations = {}
      dep.spec!.template!.metadata.annotations['tinai.cloud/deploy-triggered-at'] = new Date().toISOString()
      await appsV1.replaceNamespacedDeployment(name, cfg.stagingNamespace, dep)
    } catch { /* deployment may not exist yet */ }

    app.log.info({ app: name }, 'deploy webhook triggered')
    return { ok: true, app: name, triggered_at: new Date().toISOString() }
  })
}
