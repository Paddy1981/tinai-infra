/*
 * Webhooks & Deploy Hooks routes
 *
 * Brings Tinai to parity with Vercel deploy hooks and webhook notifications.
 *
 * Requires: 021_webhooks_and_deploy_hooks.sql
 */

import { FastifyInstance } from 'fastify'
import { randomBytes, createHmac } from 'crypto'

export async function webhooksRoutes(app: FastifyInstance) {

  // =========================================================================
  // OUTBOUND WEBHOOKS
  // =========================================================================

  // List webhooks for a project
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/webhooks', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT id, name, url, events, enabled, last_status, last_sent, created_at
         FROM webhooks WHERE tenant_id = $1 AND project_id = $2
         ORDER BY created_at DESC`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  // Create webhook
  app.post<{
    Params: { projectId: string }
    Body: { name: string; url: string; events: string[] }
  }>(
    '/projects/:projectId/webhooks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'url', 'events'],
          properties: {
            name:   { type: 'string', minLength: 1, maxLength: 100 },
            url:    { type: 'string', format: 'uri' },
            events: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { name, url, events } = req.body
      const secret = `whsec_${randomBytes(24).toString('hex')}`

      const { rows } = await app.pg.query(
        `INSERT INTO webhooks (tenant_id, project_id, name, url, secret, events)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, url, events, enabled, created_at`,
        [tenantId, req.params.projectId, name, url, secret, events],
      )

      // Return secret once on creation (like Stripe)
      return reply.status(201).send({ ...rows[0], secret })
    },
  )

  // Delete webhook
  app.delete<{ Params: { projectId: string; webhookId: string } }>(
    '/projects/:projectId/webhooks/:webhookId',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      await app.pg.query(
        `DELETE FROM webhooks WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
        [req.params.webhookId, tenantId, req.params.projectId],
      )
      return reply.status(204).send()
    },
  )

  // Webhook delivery history
  app.get<{ Params: { projectId: string; webhookId: string } }>(
    '/projects/:projectId/webhooks/:webhookId/deliveries',
    async (req) => {
      const { rows } = await app.pg.query(
        `SELECT id, event, status_code, duration_ms, attempt, created_at
           FROM webhook_deliveries WHERE webhook_id = $1
           ORDER BY created_at DESC LIMIT 50`,
        [req.params.webhookId],
      )
      return rows
    },
  )

  // =========================================================================
  // DEPLOY HOOKS (trigger deploys via URL)
  // =========================================================================

  // List deploy hooks
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/deploy-hooks', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT id, name, environment, branch, last_used, created_at
         FROM deploy_hooks WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  // Create deploy hook
  app.post<{
    Params: { projectId: string }
    Body: { name: string; environment?: string; branch?: string }
  }>(
    '/projects/:projectId/deploy-hooks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name:        { type: 'string', minLength: 1 },
            environment: { type: 'string', enum: ['production', 'staging', 'development', 'preview'] },
            branch:      { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { name, environment = 'production', branch = 'main' } = req.body
      const token = randomBytes(24).toString('hex')

      const { rows } = await app.pg.query(
        `INSERT INTO deploy_hooks (tenant_id, project_id, name, environment, branch, token)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, environment, branch`,
        [tenantId, req.params.projectId, name, environment, branch, token],
      )

      return reply.status(201).send({
        ...rows[0],
        url: `https://api.tinai.cloud/v1/deploy-hooks/${token}`,
      })
    },
  )

  // Trigger deploy hook (public, no auth needed — token IS the auth)
  app.post<{ Params: { token: string } }>('/deploy-hooks/:token', async (req, reply) => {
    const { rows } = await app.pg.query(
      `UPDATE deploy_hooks SET last_used = NOW()
       WHERE token = $1 RETURNING tenant_id, project_id, environment, branch`,
      [req.params.token],
    )
    if (!rows.length) return reply.status(404).send({ error: 'Deploy hook not found' })

    const hook = rows[0]

    // Trigger build via build-api
    const buildApiUrl = process.env.BUILD_API_URL || 'http://tinai-build-api.tinai-system.svc.cluster.local:8080'
    try {
      const resp = await fetch(`${buildApiUrl}/build/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.INTERNAL_API_TOKEN || ''}`,
        },
        body: JSON.stringify({
          tenant_id: hook.tenant_id,
          project_id: hook.project_id,
          environment: hook.environment,
          branch: hook.branch,
        }),
      })
      const data = await resp.json()
      return { triggered: true, build: data }
    } catch (e: any) {
      return reply.status(502).send({ error: 'Build API unavailable', detail: e.message })
    }
  })

  // =========================================================================
  // INTEGRATION TOKENS (scoped CI/CD tokens)
  // =========================================================================

  // List tokens
  app.get('/settings/integration-tokens', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT id, name, token_prefix, scopes, project_id, expires_at, last_used, created_at
         FROM integration_tokens WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    )
    return rows
  })

  // Create scoped token
  app.post<{ Body: { name: string; scopes: string[]; project_id?: string; expires_in_days?: number } }>(
    '/settings/integration-tokens',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'scopes'],
          properties: {
            name:    { type: 'string', minLength: 1 },
            scopes:  { type: 'array', items: { type: 'string', enum: ['read', 'write', 'deploy', 'admin'] } },
            project_id:      { type: 'string' },
            expires_in_days: { type: 'integer', minimum: 1, maximum: 365 },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { name, scopes, project_id, expires_in_days } = req.body

      const rawToken = `tni_it_${randomBytes(32).toString('hex')}`
      const tokenHash = createHmac('sha256', 'tinai-token-salt').update(rawToken).digest('hex')
      const tokenPrefix = rawToken.slice(0, 12)

      const expiresAt = expires_in_days
        ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
        : null

      const { rows } = await app.pg.query(
        `INSERT INTO integration_tokens (tenant_id, project_id, name, token_hash, token_prefix, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, token_prefix, scopes, project_id, expires_at, created_at`,
        [tenantId, project_id || null, name, tokenHash, tokenPrefix, scopes, expiresAt],
      )

      return reply.status(201).send({ ...rows[0], token: rawToken })
    },
  )

  // Revoke token
  app.delete<{ Params: { id: string } }>('/settings/integration-tokens/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId
    await app.pg.query(
      `DELETE FROM integration_tokens WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    )
    return reply.status(204).send()
  })
}

// -------------------------------------------------------------------------
// Helper: dispatch webhook event (call from other routes)
// -------------------------------------------------------------------------
export async function dispatchWebhook(
  pg: any,
  tenantId: string,
  event: string,
  payload: Record<string, any>,
) {
  const { rows: webhooks } = await pg.query(
    `SELECT id, url, secret FROM webhooks WHERE tenant_id = $1 AND enabled = true AND $2 = ANY(events)`,
    [tenantId, event],
  )

  for (const wh of webhooks) {
    const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() })
    const signature = createHmac('sha256', wh.secret).update(body).digest('hex')

    const start = Date.now()
    try {
      const resp = await fetch(wh.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tinai-Signature': `sha256=${signature}`,
          'X-Tinai-Event': event,
        },
        body,
        signal: AbortSignal.timeout(10000),
      })

      const duration = Date.now() - start
      await pg.query(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, duration_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [wh.id, event, payload, resp.status, duration],
      )
      await pg.query(
        `UPDATE webhooks SET last_status = $1, last_sent = NOW() WHERE id = $2`,
        [resp.status, wh.id],
      )
    } catch (e: any) {
      const duration = Date.now() - start
      await pg.query(
        `INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, response, duration_ms)
         VALUES ($1, $2, $3, 0, $4, $5)`,
        [wh.id, event, payload, e.message, duration],
      )
    }
  }
}
