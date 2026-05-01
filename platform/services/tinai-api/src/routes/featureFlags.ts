/*
 * Feature Flags routes — Vercel Flags / Edge Config equivalent
 *
 * Provides per-project feature flag management with percentage rollout,
 * user targeting, and environment scoping.
 *
 * Requires: 024_feature_flags.sql
 */

import { FastifyInstance } from 'fastify'

export async function featureFlagsRoutes(app: FastifyInstance) {

  // List all flags for a project
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/flags', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT id, key, name, description, kind, default_value, enabled, environments,
              rollout_pct, targeting, created_at, updated_at
         FROM feature_flags
        WHERE tenant_id = $1 AND project_id = $2
        ORDER BY key`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  // Create flag
  app.post<{
    Params: { projectId: string }
    Body: { key: string; name: string; description?: string; kind?: string; default_value?: any }
  }>(
    '/projects/:projectId/flags',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key', 'name'],
          properties: {
            key:           { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 100 },
            name:          { type: 'string', minLength: 1 },
            description:   { type: 'string' },
            kind:          { type: 'string', enum: ['boolean', 'string', 'number', 'json'] },
            default_value: {},
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).userId
      const { key, name, description, kind = 'boolean', default_value = false } = req.body

      const { rows } = await app.pg.query(
        `INSERT INTO feature_flags (tenant_id, project_id, key, name, description, kind, default_value, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, key, name, kind, default_value, enabled, created_at`,
        [tenantId, req.params.projectId, key, name, description || null, kind, JSON.stringify(default_value), userId],
      )

      // Log history
      await app.pg.query(
        `INSERT INTO feature_flag_history (flag_id, actor_id, action, new_value)
         VALUES ($1, $2, 'created', $3)`,
        [rows[0].id, userId, JSON.stringify({ key, name, kind, default_value })],
      )

      return reply.status(201).send(rows[0])
    },
  )

  // Update flag (toggle, rollout, targeting)
  app.put<{
    Params: { projectId: string; flagId: string }
    Body: { enabled?: boolean; rollout_pct?: number; targeting?: any[]; default_value?: any; environments?: string[] }
  }>(
    '/projects/:projectId/flags/:flagId',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).userId
      const { enabled, rollout_pct, targeting, default_value, environments } = req.body

      // Get current state for history
      const { rows: old } = await app.pg.query(
        `SELECT enabled, rollout_pct, targeting, default_value, environments FROM feature_flags WHERE id = $1 AND tenant_id = $2`,
        [req.params.flagId, tenantId],
      )
      if (!old.length) return reply.status(404).send({ error: 'Flag not found' })

      const { rows } = await app.pg.query(
        `UPDATE feature_flags SET
           enabled = COALESCE($3, enabled),
           rollout_pct = COALESCE($4, rollout_pct),
           targeting = COALESCE($5, targeting),
           default_value = COALESCE($6, default_value),
           environments = COALESCE($7, environments),
           updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [req.params.flagId, tenantId, enabled ?? null, rollout_pct ?? null,
         targeting ? JSON.stringify(targeting) : null, default_value !== undefined ? JSON.stringify(default_value) : null,
         environments || null],
      )

      // Log change
      const action = enabled !== undefined ? (enabled ? 'enabled' : 'disabled') : 'updated'
      await app.pg.query(
        `INSERT INTO feature_flag_history (flag_id, actor_id, action, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.params.flagId, userId, action, JSON.stringify(old[0]), JSON.stringify(rows[0])],
      )

      return rows[0]
    },
  )

  // Evaluate flag (runtime SDK endpoint — called by tenant's app)
  app.post<{
    Params: { projectId: string }
    Body: { flags: string[]; context?: Record<string, any>; environment?: string }
  }>(
    '/projects/:projectId/flags/evaluate',
    async (req) => {
      const tenantId = (req as any).tenantId
      const { flags: requestedFlags, context = {}, environment = 'production' } = req.body

      const { rows } = await app.pg.query(
        `SELECT key, default_value, enabled, rollout_pct, targeting, environments
           FROM feature_flags
          WHERE tenant_id = $1 AND project_id = $2 AND key = ANY($3)`,
        [tenantId, req.params.projectId, requestedFlags],
      )

      const result: Record<string, any> = {}
      for (const flag of rows) {
        if (!flag.enabled || !flag.environments.includes(environment)) {
          result[flag.key] = flag.default_value
          continue
        }

        // Check targeting rules
        let matched = false
        for (const rule of (flag.targeting || [])) {
          const ctxVal = context[rule.attribute]
          if (!ctxVal) continue
          switch (rule.operator) {
            case 'equals': matched = ctxVal === rule.value; break
            case 'contains': matched = String(ctxVal).includes(rule.value); break
            case 'in': matched = Array.isArray(rule.value) && rule.value.includes(ctxVal); break
          }
          if (matched) { result[flag.key] = rule.variation ?? true; break }
        }
        if (matched) continue

        // Percentage rollout (hash user ID for consistency)
        if (flag.rollout_pct < 100 && context.userId) {
          const hash = [...context.userId].reduce((a, c) => a + c.charCodeAt(0), 0) % 100
          result[flag.key] = hash < flag.rollout_pct ? true : flag.default_value
        } else {
          result[flag.key] = flag.rollout_pct >= 100 ? true : flag.default_value
        }
      }

      // Fill missing flags with null
      for (const key of requestedFlags) {
        if (!(key in result)) result[key] = null
      }

      return result
    },
  )

  // Delete flag
  app.delete<{ Params: { projectId: string; flagId: string } }>(
    '/projects/:projectId/flags/:flagId',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      await app.pg.query(
        `DELETE FROM feature_flags WHERE id = $1 AND tenant_id = $2`,
        [req.params.flagId, tenantId],
      )
      return reply.status(204).send()
    },
  )

  // Flag history
  app.get<{ Params: { projectId: string; flagId: string } }>(
    '/projects/:projectId/flags/:flagId/history',
    async (req) => {
      const { rows } = await app.pg.query(
        `SELECT fh.*, u.email AS actor_email
           FROM feature_flag_history fh
           LEFT JOIN users u ON u.id = fh.actor_id
          WHERE fh.flag_id = $1
          ORDER BY fh.created_at DESC LIMIT 50`,
        [req.params.flagId],
      )
      return rows
    },
  )
}
