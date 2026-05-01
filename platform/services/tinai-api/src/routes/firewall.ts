/*
 * Firewall / WAF routes — Vercel Firewall equivalent
 *
 * Custom rules, IP blocklists, rate limiting, and bot protection.
 *
 * Requires: 025_edge_config_and_firewall.sql
 */

import { FastifyInstance } from 'fastify'

export async function firewallRoutes(app: FastifyInstance) {

  // =========================================================================
  // FIREWALL RULES
  // =========================================================================

  // List rules
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/firewall/rules', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT * FROM firewall_rules
        WHERE tenant_id = $1 AND (project_id = $2 OR project_id IS NULL)
        ORDER BY priority, created_at`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  // Create rule
  app.post<{
    Params: { projectId: string }
    Body: {
      name: string; description?: string; action: string; conditions: any[]
      priority?: number; rate_limit?: any; enabled?: boolean
    }
  }>(
    '/projects/:projectId/firewall/rules',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'action', 'conditions'],
          properties: {
            name:        { type: 'string', minLength: 1 },
            description: { type: 'string' },
            action:      { type: 'string', enum: ['allow', 'deny', 'challenge', 'rate_limit', 'log'] },
            conditions:  { type: 'array', minItems: 1 },
            priority:    { type: 'integer', minimum: 1, maximum: 10000 },
            rate_limit:  { type: 'object' },
            enabled:     { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { name, description, action, conditions, priority = 100, rate_limit, enabled = true } = req.body

      const { rows } = await app.pg.query(
        `INSERT INTO firewall_rules (tenant_id, project_id, name, description, action, conditions, priority, rate_limit, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [tenantId, req.params.projectId, name, description || null, action,
         JSON.stringify(conditions), priority, rate_limit ? JSON.stringify(rate_limit) : null, enabled],
      )
      return reply.status(201).send(rows[0])
    },
  )

  // Update rule
  app.put<{ Params: { projectId: string; ruleId: string }; Body: Record<string, any> }>(
    '/projects/:projectId/firewall/rules/:ruleId',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { name, description, action, conditions, priority, rate_limit, enabled } = req.body

      const { rows } = await app.pg.query(
        `UPDATE firewall_rules SET
           name = COALESCE($3, name),
           description = COALESCE($4, description),
           action = COALESCE($5, action),
           conditions = COALESCE($6, conditions),
           priority = COALESCE($7, priority),
           rate_limit = COALESCE($8, rate_limit),
           enabled = COALESCE($9, enabled),
           updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.ruleId, tenantId, name, description, action,
         conditions ? JSON.stringify(conditions) : null, priority,
         rate_limit ? JSON.stringify(rate_limit) : null, enabled],
      )
      if (!rows.length) return reply.status(404).send({ error: 'Rule not found' })
      return rows[0]
    },
  )

  // Delete rule
  app.delete<{ Params: { projectId: string; ruleId: string } }>(
    '/projects/:projectId/firewall/rules/:ruleId',
    async (req, reply) => {
      await app.pg.query(`DELETE FROM firewall_rules WHERE id = $1 AND tenant_id = $2`, [req.params.ruleId, (req as any).tenantId])
      return reply.status(204).send()
    },
  )

  // =========================================================================
  // IP BLOCKLIST / ALLOWLIST
  // =========================================================================

  app.get('/firewall/ip-rules', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT * FROM ip_rules WHERE tenant_id = $1 ORDER BY action, cidr`,
      [tenantId],
    )
    return rows
  })

  app.post<{ Body: { cidr: string; action: string; reason?: string; expires_in_hours?: number } }>(
    '/firewall/ip-rules',
    {
      schema: {
        body: {
          type: 'object',
          required: ['cidr', 'action'],
          properties: {
            cidr:   { type: 'string' },
            action: { type: 'string', enum: ['allow', 'deny'] },
            reason: { type: 'string' },
            expires_in_hours: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { cidr, action, reason, expires_in_hours } = req.body
      const expiresAt = expires_in_hours ? new Date(Date.now() + expires_in_hours * 3600000).toISOString() : null

      const { rows } = await app.pg.query(
        `INSERT INTO ip_rules (tenant_id, cidr, action, reason, expires_at)
         VALUES ($1, $2::cidr, $3, $4, $5)
         ON CONFLICT (tenant_id, cidr) DO UPDATE SET action = $3, reason = $4, expires_at = $5
         RETURNING *`,
        [tenantId, cidr, action, reason || null, expiresAt],
      )
      return reply.status(201).send(rows[0])
    },
  )

  app.delete<{ Params: { id: string } }>('/firewall/ip-rules/:id', async (req, reply) => {
    await app.pg.query(`DELETE FROM ip_rules WHERE id = $1 AND tenant_id = $2`, [req.params.id, (req as any).tenantId])
    return reply.status(204).send()
  })

  // =========================================================================
  // EDGE CONFIG (Key-Value Store)
  // =========================================================================

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/edge-config', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT key, value, updated_at FROM edge_config WHERE tenant_id = $1 AND project_id = $2 ORDER BY key`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  app.get<{ Params: { projectId: string; key: string } }>('/projects/:projectId/edge-config/:key', async (req, reply) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT value, digest, updated_at FROM edge_config WHERE tenant_id = $1 AND project_id = $2 AND key = $3`,
      [tenantId, req.params.projectId, req.params.key],
    )
    if (!rows.length) return reply.status(404).send({ error: 'Key not found' })
    reply.header('ETag', rows[0].digest)
    return rows[0].value
  })

  app.put<{ Params: { projectId: string; key: string }; Body: { value: any } }>(
    '/projects/:projectId/edge-config/:key',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { value } = req.body
      const { createHash } = await import('crypto')
      const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

      const { rows } = await app.pg.query(
        `INSERT INTO edge_config (tenant_id, project_id, key, value, digest)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, project_id, key)
         DO UPDATE SET value = $4, digest = $5, updated_at = NOW()
         RETURNING key, value, digest, updated_at`,
        [tenantId, req.params.projectId, req.params.key, JSON.stringify(value), digest],
      )
      return rows[0]
    },
  )

  app.delete<{ Params: { projectId: string; key: string } }>(
    '/projects/:projectId/edge-config/:key',
    async (req, reply) => {
      await app.pg.query(
        `DELETE FROM edge_config WHERE tenant_id = $1 AND project_id = $2 AND key = $3`,
        [(req as any).tenantId, req.params.projectId, req.params.key],
      )
      return reply.status(204).send()
    },
  )
}
