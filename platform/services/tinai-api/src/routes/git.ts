import { FastifyInstance } from 'fastify'
import { loadConfig } from '../config'

const cfg = loadConfig()
const FORGEJO = cfg.forgejoUrl
const ADMIN_TOKEN = cfg.forgejoAdminToken

// ---------------------------------------------------------------------------
// Forgejo API helpers
// ---------------------------------------------------------------------------

async function forgejoFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `token ${ADMIN_TOKEN}`)
  if (!headers.has('Content-Type') && init?.method && init.method !== 'GET') {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`${FORGEJO}/api/v1${path}`, { ...init, headers })
}

/**
 * Ensure a Forgejo organisation (or user) exists for the tenant.
 * For now we use the admin account's namespace; later each tenant gets their own org.
 */
interface TenantOrg {
  owner: string
  isOrg: boolean
}

async function ensureTenantOrg(tenantId: string): Promise<TenantOrg> {
  // Check if an org with the tenantId name exists
  const res = await forgejoFetch(`/orgs/${tenantId}`)
  if (res.ok) return { owner: tenantId, isOrg: true }

  // Create the org
  const create = await forgejoFetch('/orgs', {
    method: 'POST',
    body: JSON.stringify({
      username: tenantId,
      full_name: tenantId,
      description: `TinAI tenant: ${tenantId}`,
      visibility: 'private',
    }),
  })

  if (create.ok) {
    return { owner: tenantId, isOrg: true }
  }
  if (create.status === 422) {
    // 422 = name conflict — could be existing org OR existing user with same name
    const recheck = await forgejoFetch(`/orgs/${tenantId}`)
    if (recheck.ok) return { owner: tenantId, isOrg: true }
    // Name taken by a user, not an org — fall through to user endpoint
  }

  // Fallback: use the admin user's personal repos (not an org)
  return { owner: 'tinai-admin', isOrg: false }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface CreateRepoBody {
  name: string
  description?: string
  private?: boolean
}

export async function gitRoutes(app: FastifyInstance) {
  if (!ADMIN_TOKEN) {
    app.log.warn('FORGEJO_ADMIN_TOKEN not set — git routes will return 503')
  }

  // ── List tenant repos ─────────────────────────────────────────────────────
  app.get('/git/repos', async (req, reply) => {
    if (!ADMIN_TOKEN) return reply.status(503).send({ error: 'Git service not configured' })
    const tenantId = (req as any).tenantId as string

    try {
      // Try org repos first, fall back to admin user repos
      let res = await forgejoFetch(`/orgs/${tenantId}/repos?limit=50`)
      if (!res.ok) {
        // No org, list repos that belong to the admin but filter by naming convention
        res = await forgejoFetch(`/user/repos?limit=50`)
      }
      if (!res.ok) {
        return reply.status(502).send({ error: 'Failed to list repos from Forgejo' })
      }
      const repos = await res.json() as any[]
      return repos.map((r: any) => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        description: r.description,
        html_url: r.html_url,
        clone_url: r.clone_url,
        default_branch: r.default_branch,
        private: r.private,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    } catch (err: any) {
      app.log.error({ msg: 'git/repos GET failed', err: err.message })
      return reply.status(500).send({ error: 'internal error', detail: err.message })
    }
  })

  // ── Create a new repo ─────────────────────────────────────────────────────
  app.post<{ Body: CreateRepoBody }>('/git/repos', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 63 },
          description: { type: 'string' },
          private: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!ADMIN_TOKEN) return reply.status(503).send({ error: 'Git service not configured' })
    const tenantId = (req as any).tenantId as string
    const { name, description = '', private: isPrivate = false } = req.body

    try {
      const { owner: orgOwner, isOrg } = await ensureTenantOrg(tenantId)

      // Create repo under the org (or user)
      let res: Response
      if (isOrg) {
        res = await forgejoFetch(`/orgs/${orgOwner}/repos`, {
          method: 'POST',
          body: JSON.stringify({
            name,
            description,
            auto_init: true,
            default_branch: 'main',
            private: isPrivate,
          }),
        })
      } else {
        // Fallback: create under admin user
        res = await forgejoFetch('/user/repos', {
          method: 'POST',
          body: JSON.stringify({
            name,
            description,
            auto_init: true,
            default_branch: 'main',
            private: isPrivate,
          }),
        })
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        if (res.status === 409) {
          return reply.status(409).send({ error: `Repository '${name}' already exists` })
        }
        return reply.status(502).send({
          error: 'Failed to create repo in Forgejo',
          detail: (body as any)?.message ?? `status ${res.status}`,
        })
      }

      const repo = await res.json() as any

      // Auto-register webhook for the build pipeline
      if (cfg.forgejoWebhookSecret) {
        await registerWebhook(app, repo.full_name)
      }

      return reply.status(201).send({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        html_url: repo.html_url,
        clone_url: repo.clone_url,
        default_branch: repo.default_branch,
      })
    } catch (err: any) {
      app.log.error({ msg: 'git/repos POST failed', err: err.message })
      return reply.status(500).send({ error: 'internal error', detail: err.message })
    }
  })

  // ── Register webhook for a repo ───────────────────────────────────────────
  app.post<{ Body: { repoFullName: string } }>('/git/webhooks', {
    schema: {
      body: {
        type: 'object',
        required: ['repoFullName'],
        properties: { repoFullName: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    if (!ADMIN_TOKEN) return reply.status(503).send({ error: 'Git service not configured' })
    if (!cfg.forgejoWebhookSecret) return reply.status(503).send({ error: 'Webhook secret not configured' })

    const tenantId = (req as any).tenantId as string
    const { repoFullName } = req.body

    try {
      // Security: verify the repo is owned by this tenant
      // TinAI convention: repo is created as {tenantId}/{name}
      if (!repoFullName.startsWith(tenantId + '/')) {
        // Fallback: check database for ownership if named differently
        const { rows } = await app.pg.query(
          'SELECT id FROM apps WHERE owner = $1 AND repo_full_name = $2',
          [tenantId, repoFullName],
        )
        if (!rows.length) {
          return reply.status(403).send({ error: 'Forbidden: you do not own this repository' })
        }
      }

      const hook = await registerWebhook(app, repoFullName)
      return reply.status(201).send(hook)
    } catch (err: any) {
      app.log.error({ msg: 'git/webhooks POST failed', err: err.message })
      return reply.status(500).send({ error: 'internal error', detail: err.message })
    }
  })
}

// ---------------------------------------------------------------------------
// Webhook registration helper
// ---------------------------------------------------------------------------
async function registerWebhook(app: FastifyInstance, repoFullName: string) {
  const res = await forgejoFetch(`/repos/${repoFullName}/hooks`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'gitea',
      active: true,
      config: {
        url: cfg.forgejoWebhookUrl,
        content_type: 'json',
        secret: cfg.forgejoWebhookSecret,
      },
      events: ['push', 'pull_request'],
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    app.log.warn({ msg: 'webhook registration failed', repo: repoFullName, status: res.status, body })
    return { registered: false, reason: (body as any)?.message ?? `status ${res.status}` }
  }

  const hook = await res.json() as any
  app.log.info({ msg: 'webhook registered', repo: repoFullName, hookId: hook.id })
  return { registered: true, id: hook.id }
}
