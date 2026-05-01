import { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Body shapes
// ---------------------------------------------------------------------------

interface EnvVarBody {
  key: string
  value: string
  is_secret?: boolean
}

interface EnvVarUpdateBody {
  value: string
  is_secret?: boolean
}

interface BulkEnvVarBody {
  vars: Array<{ key: string; value: string; is_secret?: boolean }>
}

interface SecretBody {
  key: string
  value: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask a secret value so it is safe to return in API responses. */
function masked(): string {
  return '***'
}

/** Return true if the requesting user is an admin. */
function isAdmin(req: any): boolean {
  return (req as any).role === 'admin'
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function envVarsRoutes(app: FastifyInstance) {

  // ==========================================================================
  // Per-workload env vars
  // ==========================================================================

  // -------------------------------------------------------------------------
  // GET /workloads/:id/env — list env vars (secrets masked unless reveal+admin)
  // -------------------------------------------------------------------------
  app.get<{
    Params: { id: string }
    Querystring: { reveal?: string }
  }>('/workloads/:id/env', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params
    const reveal = req.query.reveal === 'true' && isAdmin(req)

    // Verify workload ownership
    const { rows: [workload] } = await app.pg.query(
      `SELECT id, tenant_id FROM workloads WHERE id = $1`,
      [id],
    )
    if (!workload) return reply.status(404).send({ error: 'workload not found' })
    if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      `SELECT id, workload_id, key, value, is_secret, created_at, updated_at
       FROM workload_env_vars
       WHERE workload_id = $1
       ORDER BY key ASC`,
      [id],
    )

    return rows.map((row: any) => ({
      ...row,
      value: row.is_secret && !reveal ? masked() : row.value,
    }))
  })

  // -------------------------------------------------------------------------
  // POST /workloads/:id/env — create env var
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: EnvVarBody }>(
    '/workloads/:id/env',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key', 'value'],
          properties: {
            key:       { type: 'string', minLength: 1, maxLength: 255 },
            value:     { type: 'string' },
            is_secret: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id } = req.params
      const { key, value, is_secret = false } = req.body

      // Verify workload ownership
      const { rows: [workload] } = await app.pg.query(
        `SELECT id, tenant_id FROM workloads WHERE id = $1`,
        [id],
      )
      if (!workload) return reply.status(404).send({ error: 'workload not found' })
      if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      try {
        const { rows: [envVar] } = await app.pg.query(
          `INSERT INTO workload_env_vars (workload_id, tenant_id, key, value, is_secret)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, workload_id, key, is_secret, created_at, updated_at`,
          [id, tenantId, key, value, is_secret],
        )
        return reply.status(201).send({
          ...envVar,
          value: is_secret ? masked() : value,
        })
      } catch (e: any) {
        if (e.code === '23505') {
          return reply.status(409).send({ error: `env var "${key}" already exists on this workload` })
        }
        throw e
      }
    },
  )

  // -------------------------------------------------------------------------
  // PUT /workloads/:id/env/:key — update env var value
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string; key: string }; Body: EnvVarUpdateBody }>(
    '/workloads/:id/env/:key',
    {
      schema: {
        body: {
          type: 'object',
          required: ['value'],
          properties: {
            value:     { type: 'string' },
            is_secret: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id, key } = req.params
      const { value, is_secret } = req.body

      // Verify workload ownership
      const { rows: [workload] } = await app.pg.query(
        `SELECT id, tenant_id FROM workloads WHERE id = $1`,
        [id],
      )
      if (!workload) return reply.status(404).send({ error: 'workload not found' })
      if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      // Build dynamic SET clause
      const setClauses: string[] = ['value = $1', 'updated_at = NOW()']
      const params: unknown[] = [value]

      if (is_secret !== undefined) {
        params.push(is_secret)
        setClauses.push(`is_secret = $${params.length}`)
      }

      params.push(id, key)
      const idxId  = params.length - 1
      const idxKey = params.length

      const { rows: [updated] } = await app.pg.query(
        `UPDATE workload_env_vars
         SET ${setClauses.join(', ')}
         WHERE workload_id = $${idxId} AND key = $${idxKey}
         RETURNING id, workload_id, key, is_secret, created_at, updated_at`,
        params,
      )

      if (!updated) return reply.status(404).send({ error: 'env var not found' })

      return {
        ...updated,
        value: updated.is_secret ? masked() : value,
      }
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /workloads/:id/env/:key — delete env var
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; key: string } }>(
    '/workloads/:id/env/:key',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id, key } = req.params

      // Verify workload ownership
      const { rows: [workload] } = await app.pg.query(
        `SELECT id, tenant_id FROM workloads WHERE id = $1`,
        [id],
      )
      if (!workload) return reply.status(404).send({ error: 'workload not found' })
      if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      const { rowCount } = await app.pg.query(
        `DELETE FROM workload_env_vars WHERE workload_id = $1 AND key = $2`,
        [id, key],
      )

      if (!rowCount) return reply.status(404).send({ error: 'env var not found' })
      return reply.status(204).send()
    },
  )

  // -------------------------------------------------------------------------
  // POST /workloads/:id/env/bulk — upsert many env vars at once
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: BulkEnvVarBody }>(
    '/workloads/:id/env/bulk',
    {
      schema: {
        body: {
          type: 'object',
          required: ['vars'],
          properties: {
            vars: {
              type: 'array',
              items: {
                type: 'object',
                required: ['key', 'value'],
                properties: {
                  key:       { type: 'string', minLength: 1, maxLength: 255 },
                  value:     { type: 'string' },
                  is_secret: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id } = req.params
      const { vars } = req.body

      // Verify workload ownership
      const { rows: [workload] } = await app.pg.query(
        `SELECT id, tenant_id FROM workloads WHERE id = $1`,
        [id],
      )
      if (!workload) return reply.status(404).send({ error: 'workload not found' })
      if (workload.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      if (!vars.length) return reply.status(200).send({ upserted: 0 })

      // Build multi-row upsert
      const values: unknown[] = []
      const rowPlaceholders: string[] = []

      for (const v of vars) {
        const base = values.length
        values.push(id, tenantId, v.key, v.value, v.is_secret ?? false)
        rowPlaceholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`)
      }

      const { rowCount } = await app.pg.query(
        `INSERT INTO workload_env_vars (workload_id, tenant_id, key, value, is_secret)
         VALUES ${rowPlaceholders.join(', ')}
         ON CONFLICT (workload_id, key) DO UPDATE
           SET value     = EXCLUDED.value,
               is_secret = EXCLUDED.is_secret,
               updated_at = NOW()`,
        values,
      )

      return { upserted: rowCount ?? vars.length }
    },
  )

  // ==========================================================================
  // Per-project secrets
  // ==========================================================================

  // -------------------------------------------------------------------------
  // GET /projects/:id/secrets — list secret keys (names only, no values unless reveal+admin)
  // -------------------------------------------------------------------------
  app.get<{
    Params: { id: string }
    Querystring: { reveal?: string }
  }>('/projects/:id/secrets', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params
    const reveal = req.query.reveal === 'true' && isAdmin(req)

    // Verify project ownership
    const { rows: [project] } = await app.pg.query(
      `SELECT id, tenant_id FROM projects WHERE id = $1`,
      [id],
    )
    if (!project) return reply.status(404).send({ error: 'project not found' })
    if (project.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      `SELECT id, project_id, key, value, created_at, updated_at
       FROM project_secrets
       WHERE project_id = $1
       ORDER BY key ASC`,
      [id],
    )

    return rows.map((row: any) => ({
      id:         row.id,
      project_id: row.project_id,
      key:        row.key,
      value:      reveal ? row.value : masked(),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }))
  })

  // -------------------------------------------------------------------------
  // POST /projects/:id/secrets — create or update a secret
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: SecretBody }>(
    '/projects/:id/secrets',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key', 'value'],
          properties: {
            key:   { type: 'string', minLength: 1, maxLength: 255 },
            value: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id } = req.params
      const { key, value } = req.body

      // Verify project ownership
      const { rows: [project] } = await app.pg.query(
        `SELECT id, tenant_id FROM projects WHERE id = $1`,
        [id],
      )
      if (!project) return reply.status(404).send({ error: 'project not found' })
      if (project.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      const { rows: [secret] } = await app.pg.query(
        `INSERT INTO project_secrets (project_id, tenant_id, key, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, key) DO UPDATE
           SET value      = EXCLUDED.value,
               updated_at = NOW()
         RETURNING id, project_id, key, created_at, updated_at`,
        [id, tenantId, key, value],
      )

      return reply.status(201).send({
        ...secret,
        value: masked(),
      })
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /projects/:id/secrets/:key — delete a secret
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; key: string } }>(
    '/projects/:id/secrets/:key',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id, key } = req.params

      // Verify project ownership
      const { rows: [project] } = await app.pg.query(
        `SELECT id, tenant_id FROM projects WHERE id = $1`,
        [id],
      )
      if (!project) return reply.status(404).send({ error: 'project not found' })
      if (project.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      const { rowCount } = await app.pg.query(
        `DELETE FROM project_secrets WHERE project_id = $1 AND key = $2`,
        [id, key],
      )

      if (!rowCount) return reply.status(404).send({ error: 'secret not found' })
      return reply.status(204).send()
    },
  )
}
