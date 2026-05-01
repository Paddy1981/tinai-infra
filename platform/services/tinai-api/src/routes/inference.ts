import { FastifyInstance } from 'fastify'

interface CreateEndpointBody {
  name: string
  provider: string
  model: string
  rpm_limit?: number
  tpm_limit?: number
  monthly_budget_paise?: number
}

interface PatchEndpointBody {
  rpm_limit?: number
  tpm_limit?: number
  monthly_budget_paise?: number
  status?: string
}

export async function inferenceRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /inference/models — list all active models grouped by provider
  // ---------------------------------------------------------------------------
  app.get('/inference/models', async (_req, _reply) => {
    const { rows } = await app.pg.query(
      `SELECT id, provider, model_id, name, context_window,
              input_price_per_1m_paise, output_price_per_1m_paise, is_active
       FROM inference_models
       WHERE is_active = true
       ORDER BY provider, name`,
    )

    // Group by provider
    const grouped: Record<string, typeof rows> = {}
    for (const row of rows) {
      if (!grouped[row.provider]) grouped[row.provider] = []
      grouped[row.provider].push(row)
    }

    return grouped
  })

  // ---------------------------------------------------------------------------
  // GET /inference/endpoints — list tenant's endpoints (exclude deleted)
  // ---------------------------------------------------------------------------
  app.get('/inference/endpoints', async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    const { rows } = await app.pg.query(
      `SELECT
         e.id, e.name, e.provider, e.model, e.rpm_limit, e.tpm_limit,
         e.monthly_budget_paise, e.status, e.created_at,
         m.name AS model_name, m.context_window,
         m.input_price_per_1m_paise, m.output_price_per_1m_paise
       FROM inference_endpoints e
       LEFT JOIN inference_models m ON m.model_id = e.model
       WHERE e.tenant_id = $1 AND e.status != 'deleted'
       ORDER BY e.created_at DESC`,
      [tenantId],
    )

    return rows
  })

  // ---------------------------------------------------------------------------
  // POST /inference/endpoints — create a new endpoint
  // ---------------------------------------------------------------------------
  app.post<{ Body: CreateEndpointBody }>(
    '/inference/endpoints',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'provider', 'model'],
          properties: {
            name:                 { type: 'string', minLength: 1, maxLength: 128 },
            provider:             { type: 'string' },
            model:                { type: 'string' },
            rpm_limit:            { type: 'integer', minimum: 1 },
            tpm_limit:            { type: 'integer', minimum: 1 },
            monthly_budget_paise: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const {
        name,
        provider,
        model,
        rpm_limit = 60,
        tpm_limit = 100000,
        monthly_budget_paise = 0,
      } = req.body

      // Validate provider + model exist in catalog
      const { rows: modelRows } = await app.pg.query(
        `SELECT id FROM inference_models WHERE provider = $1 AND model_id = $2 AND is_active = true`,
        [provider, model],
      )
      if (!modelRows.length) {
        return reply.status(422).send({
          error: `model '${model}' not found for provider '${provider}' or is inactive`,
        })
      }

      const { rows: [endpoint] } = await app.pg.query(
        `INSERT INTO inference_endpoints
           (tenant_id, name, provider, model, rpm_limit, tpm_limit, monthly_budget_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, tenant_id, name, provider, model, rpm_limit, tpm_limit,
                   monthly_budget_paise, status, created_at`,
        [tenantId, name, provider, model, rpm_limit, tpm_limit, monthly_budget_paise],
      )

      return reply.status(201).send(endpoint)
    },
  )

  // ---------------------------------------------------------------------------
  // GET /inference/endpoints/:id — get single endpoint with ownership check
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/inference/endpoints/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows } = await app.pg.query(
      `SELECT
         e.id, e.tenant_id, e.name, e.provider, e.model, e.rpm_limit, e.tpm_limit,
         e.monthly_budget_paise, e.status, e.created_at,
         m.name AS model_name, m.context_window,
         m.input_price_per_1m_paise, m.output_price_per_1m_paise
       FROM inference_endpoints e
       LEFT JOIN inference_models m ON m.model_id = e.model
       WHERE e.id = $1 AND e.status != 'deleted'`,
      [id],
    )

    if (!rows.length) return reply.status(404).send({ error: 'endpoint not found' })

    const endpoint = rows[0]
    if (endpoint.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    return endpoint
  })

  // ---------------------------------------------------------------------------
  // PATCH /inference/endpoints/:id — update rate limits, budget, or status
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: PatchEndpointBody }>(
    '/inference/endpoints/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            rpm_limit:            { type: 'integer', minimum: 1 },
            tpm_limit:            { type: 'integer', minimum: 1 },
            monthly_budget_paise: { type: 'integer', minimum: 0 },
            status:               { type: 'string', enum: ['active', 'paused'] },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id } = req.params

      // Ownership check
      const { rows: existing } = await app.pg.query(
        `SELECT id, tenant_id, status FROM inference_endpoints WHERE id = $1`,
        [id],
      )
      if (!existing.length || existing[0].status === 'deleted') {
        return reply.status(404).send({ error: 'endpoint not found' })
      }
      if (existing[0].tenant_id !== tenantId) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const { rpm_limit, tpm_limit, monthly_budget_paise, status } = req.body

      // Build dynamic SET clause for only provided fields
      const setClauses: string[] = []
      const values: any[] = []

      if (rpm_limit !== undefined) {
        values.push(rpm_limit)
        setClauses.push(`rpm_limit = $${values.length}`)
      }
      if (tpm_limit !== undefined) {
        values.push(tpm_limit)
        setClauses.push(`tpm_limit = $${values.length}`)
      }
      if (monthly_budget_paise !== undefined) {
        values.push(monthly_budget_paise)
        setClauses.push(`monthly_budget_paise = $${values.length}`)
      }
      if (status !== undefined) {
        values.push(status)
        setClauses.push(`status = $${values.length}`)
      }

      if (!setClauses.length) {
        return reply.status(400).send({ error: 'no updatable fields provided' })
      }

      values.push(id)
      const { rows: [updated] } = await app.pg.query(
        `UPDATE inference_endpoints
         SET ${setClauses.join(', ')}
         WHERE id = $${values.length}
         RETURNING id, name, provider, model, rpm_limit, tpm_limit,
                   monthly_budget_paise, status, created_at`,
        values,
      )

      return updated
    },
  )

  // ---------------------------------------------------------------------------
  // DELETE /inference/endpoints/:id — soft delete (status = 'deleted')
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/inference/endpoints/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows } = await app.pg.query(
      `SELECT id, tenant_id, status FROM inference_endpoints WHERE id = $1`,
      [id],
    )
    if (!rows.length || rows[0].status === 'deleted') {
      return reply.status(404).send({ error: 'endpoint not found' })
    }
    if (rows[0].tenant_id !== tenantId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    await app.pg.query(
      `UPDATE inference_endpoints SET status = 'deleted' WHERE id = $1`,
      [id],
    )

    return reply.status(200).send({ ok: true, id, status: 'deleted' })
  })

  // ---------------------------------------------------------------------------
  // GET /inference/endpoints/:id/usage — daily usage for the last N days
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/inference/endpoints/:id/usage',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id } = req.params

      // Parse and clamp days param (default 30, max 90)
      const rawDays = parseInt(req.query.days ?? '30', 10)
      const days = isNaN(rawDays) || rawDays < 1 ? 30 : Math.min(rawDays, 90)

      // Ownership check
      const { rows: existing } = await app.pg.query(
        `SELECT id, tenant_id, status FROM inference_endpoints WHERE id = $1`,
        [id],
      )
      if (!existing.length || existing[0].status === 'deleted') {
        return reply.status(404).send({ error: 'endpoint not found' })
      }
      if (existing[0].tenant_id !== tenantId) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // Generate a series of the last N days and left-join actual usage so
      // days with no traffic are zero-filled rather than omitted.
      const { rows } = await app.pg.query(
        `SELECT
           gs.day::date AS day,
           COALESCE(u.request_count, 0) AS request_count,
           COALESCE(u.input_tokens,  0) AS input_tokens,
           COALESCE(u.output_tokens, 0) AS output_tokens,
           COALESCE(u.cost_paise,    0) AS cost_paise
         FROM generate_series(
           CURRENT_DATE - ($2::int - 1) * INTERVAL '1 day',
           CURRENT_DATE,
           INTERVAL '1 day'
         ) AS gs(day)
         LEFT JOIN inference_usage u
           ON u.endpoint_id = $1 AND u.day = gs.day::date
         ORDER BY gs.day ASC`,
        [id, days],
      )

      return rows
    },
  )
}
