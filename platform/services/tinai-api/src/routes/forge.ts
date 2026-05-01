/**
 * forge.ts — Fastify plugin that proxies all /api/forge/* requests to the
 * TinAI Forge service (tinai-forge.tinai-forge.svc.cluster.local:8090).
 *
 * Rewritten from Express Router to a Fastify plugin to match the rest of
 * tinai-api which uses Fastify, not Express. Uses native fetch (Node 18+)
 * instead of axios to avoid an extra dependency.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

const FORGE_API_BASE =
  process.env.FORGE_API_URL ||
  'http://tinai-forge.tinai-forge.svc.cluster.local:8090'
const FORGE_API_KEY = process.env.FORGE_API_KEY || ''

function forgeHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  // tinai-forge checks X-Forge-API-Key (set by its auth middleware)
  if (FORGE_API_KEY) h['X-Forge-API-Key'] = FORGE_API_KEY
  return h
}

/**
 * Proxy a request to the Forge service.
 * Returns { ok, status, data } — never throws.
 * On network failure / timeout returns { ok: false, status: 503, data: null }.
 */
async function proxyToForge(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${FORGE_API_BASE}${path}`, {
      method,
      headers: forgeHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    clearTimeout(timer)
    let data: unknown = null
    try { data = await res.json() } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, data }
  } catch {
    clearTimeout(timer)
    return { ok: false, status: 503, data: null }
  }
}

export async function forgeRoutes(app: FastifyInstance) {

  // ── Products ──────────────────────────────────────────────────────────────

  app.get('/forge/products', async (_req: FastifyRequest, reply: FastifyReply) => {
    const r = await proxyToForge('/api/forge/products')
    if (!r.ok && r.data === null) {
      return reply.status(503).send({ error: 'forge service unavailable', forge_status: 'not_deployed' })
    }
    return reply.status(r.status).send(r.data)
  })

  app.get(
    '/forge/products/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const r = await proxyToForge(`/api/forge/products/${req.params.id}`)
      return reply.status(r.status).send(r.data)
    },
  )

  app.post(
    '/forge/products/:id/check',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const r = await proxyToForge(`/api/forge/products/${req.params.id}/check`, 'POST')
      return reply.status(r.status).send(r.data)
    },
  )

  app.post(
    '/forge/products/:id/build',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const r = await proxyToForge(`/api/forge/products/${req.params.id}/build`, 'POST', req.body)
      return reply.status(r.ok ? 202 : r.status).send(r.data)
    },
  )

  // ── Builds ────────────────────────────────────────────────────────────────

  app.get('/forge/builds', async (_req: FastifyRequest, reply: FastifyReply) => {
    const r = await proxyToForge('/api/forge/builds')
    return reply.status(r.status).send(r.data)
  })

  app.get(
    '/forge/builds/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const r = await proxyToForge(`/api/forge/builds/${req.params.id}`)
      return reply.status(r.status).send(r.data)
    },
  )

  app.post('/forge/builds', async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await proxyToForge('/api/forge/builds', 'POST', req.body)
    return reply.status(r.ok ? 202 : r.status).send(r.data)
  })

  // ── Tests ─────────────────────────────────────────────────────────────────

  app.get(
    '/forge/tests/:buildId',
    async (req: FastifyRequest<{ Params: { buildId: string } }>, reply: FastifyReply) => {
      const r = await proxyToForge(`/api/forge/tests/${req.params.buildId}`)
      return reply.status(r.status).send(r.data)
    },
  )

  // ── Rollouts ──────────────────────────────────────────────────────────────

  app.get('/forge/rollouts', async (_req: FastifyRequest, reply: FastifyReply) => {
    const r = await proxyToForge('/api/forge/rollouts')
    return reply.status(r.status).send(r.data)
  })

  app.post('/forge/rollouts', async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await proxyToForge('/api/forge/rollouts', 'POST', req.body)
    return reply.status(r.ok ? 202 : r.status).send(r.data)
  })

  app.get(
    '/forge/rollouts/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const r = await proxyToForge(`/api/forge/rollouts/${req.params.id}`)
      return reply.status(r.status).send(r.data)
    },
  )

  app.post(
    '/forge/rollouts/:id/pause',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const r = await proxyToForge(`/api/forge/rollouts/${req.params.id}/pause`, 'POST')
      return reply.status(r.status).send(r.data)
    },
  )

  app.post(
    '/forge/rollouts/:id/rollback',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const r = await proxyToForge(`/api/forge/rollouts/${req.params.id}/rollback`, 'POST', req.body)
      return reply.status(r.status).send(r.data)
    },
  )

  // ── Patches ───────────────────────────────────────────────────────────────

  app.get('/forge/patches', async (_req: FastifyRequest, reply: FastifyReply) => {
    const r = await proxyToForge('/api/forge/patches')
    return reply.status(r.status).send(r.data)
  })

  app.get(
    '/forge/patches/:product',
    async (req: FastifyRequest<{ Params: { product: string } }>, reply: FastifyReply) => {
      const r = await proxyToForge(`/api/forge/patches/${req.params.product}`)
      return reply.status(r.status).send(r.data)
    },
  )

  // ── Aggregate status (used by dashboard header badge) ─────────────────────

  app.get('/forge/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [productsR, buildsR, rolloutsR] = await Promise.allSettled([
      proxyToForge('/api/forge/products'),
      proxyToForge('/api/forge/builds'),
      proxyToForge('/api/forge/rollouts'),
    ])

    const products = productsR.status === 'fulfilled' && productsR.value.ok
      ? (productsR.value.data as unknown[]) : null
    const builds = buildsR.status === 'fulfilled' && buildsR.value.ok
      ? (buildsR.value.data as unknown[]) : null
    const rollouts = rolloutsR.status === 'fulfilled' && rolloutsR.value.ok
      ? (rolloutsR.value.data as unknown[]) : null

    if (!products && !builds && !rollouts) {
      return reply.send({
        forge_status: 'not_deployed',
        products: 11,
        updates_available: 0,
        builds_today: 0,
        active_rollouts: 0,
        last_check: null,
      })
    }

    const pl = Array.isArray(products) ? (products as any[]) : []
    const bl = Array.isArray(builds) ? (builds as any[]) : []
    const rl = Array.isArray(rollouts) ? (rollouts as any[]) : []
    const today = new Date().toISOString().split('T')[0]

    return reply.send({
      forge_status: 'online',
      products: pl.length,
      updates_available: pl.filter(p => p.status === 'update_available').length,
      builds_today: bl.filter(b => b.started_at?.startsWith(today)).length,
      active_rollouts: rl.filter(r => r.status === 'in_progress').length,
      last_check: pl[0]?.last_checked_at ?? null,
    })
  })

  // ── Backbone callbacks: tinai-forge → tinai-api ───────────────────────────
  //
  // tinai-forge POSTs to these endpoints when a build or rollout finishes.
  // This is the notification backbone — tinai-forge does not need to know
  // about tenants; tinai-api owns the tenant registry and handles follow-ups:
  //   1. Write an audit log entry
  //   2. (Future) Send admin notification email
  //   3. (Future) Update tenant version in main DB
  //
  // These endpoints are intentionally NOT protected by the user JWT — they are
  // called by the internal forge service using X-Forge-API-Key instead.

  app.post('/forge/callbacks/build-complete', {
    config: { skipJwtAuth: true } as any,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    // Validate internal API key
    const key = req.headers['x-forge-api-key']
    if (!FORGE_API_KEY) {
      return reply.status(503).send({ error: 'service not configured' })
    }
    if (key !== FORGE_API_KEY) {
      return reply.status(401).send({ error: 'unauthorized' })
    }

    const payload = req.body as {
      build_id: number
      product_id: string
      version: string
      image_tag: string
      status: 'passed' | 'failed'
      triggered_by?: string
    }

    const server = req.server as any
    try {
      await server.pg.query(
        `INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
        [
          'system',
          payload.status === 'passed' ? 'forge.build.passed' : 'forge.build.failed',
          'forge_build',
          String(payload.build_id),
          JSON.stringify(payload),
        ],
      )
    } catch {
      // audit_log table may not have this schema yet — non-fatal, log and continue
      server.log?.warn('forge build callback: audit_log insert failed (schema may need migration)')
    }

    return reply.status(202).send({ received: true })
  })

  app.post('/forge/callbacks/rollout-complete', {
    config: { skipJwtAuth: true } as any,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers['x-forge-api-key']
    if (!FORGE_API_KEY) {
      return reply.status(503).send({ error: 'service not configured' })
    }
    if (key !== FORGE_API_KEY) {
      return reply.status(401).send({ error: 'unauthorized' })
    }

    const payload = req.body as {
      rollout_id: number
      product_id: string
      to_version: string
      status: 'completed' | 'rolled_back'
      affected_tenants: number
    }

    const server = req.server as any
    try {
      await server.pg.query(
        `INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
        [
          'system',
          payload.status === 'completed' ? 'forge.rollout.completed' : 'forge.rollout.rolled_back',
          'forge_rollout',
          String(payload.rollout_id),
          JSON.stringify(payload),
        ],
      )
    } catch {
      server.log?.warn('forge rollout callback: audit_log insert failed (schema may need migration)')
    }

    return reply.status(202).send({ received: true })
  })
}
