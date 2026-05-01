import { FastifyInstance } from 'fastify'
import { writeAuditEvent } from '../utils/audit'

interface ErasureRequestRow {
  id: string
  tenant_id: string
  requester_email: string
  data_categories: string[]
  full_erasure: boolean
  status: string
  requested_at: string
  completed_at: string | null
  sla_deadline: string
}

interface CreateErasureBody {
  tenant_id: string
  requester_email: string
  data_categories?: string[]
  full_erasure?: boolean
}

export async function erasureRoutes(app: FastifyInstance) {
  // POST /compliance/erasure — create a new erasure request, tenant_id from JWT
  app.post<{ Body: CreateErasureBody }>('/compliance/erasure', {
    schema: {
      body: {
        type: 'object',
        required: ['tenant_id', 'requester_email'],
        properties: {
          tenant_id:        { type: 'string' },
          requester_email:  { type: 'string' },
          data_categories:  { type: 'array', items: { type: 'string' } },
          full_erasure:     { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    // tenant_id is always taken from the JWT — the body field is ignored to prevent spoofing
    const tenant_id = (req as any).tenantId as string
    const {
      requester_email,
      data_categories = [],
      full_erasure = false,
    } = req.body

    const { rows } = await app.pg.query<ErasureRequestRow>(
      `INSERT INTO erasure_requests
         (tenant_id, requester_email, data_categories, full_erasure, sla_deadline)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')
       RETURNING *`,
      [tenant_id, requester_email, data_categories, full_erasure],
    )

    await writeAuditEvent(app, {
      tenant_id,
      action: 'erasure_request_created',
      resource: 'erasure_requests',
      resource_id: rows[0].id,
      metadata: {
        requester_email,
        data_categories,
        full_erasure,
        sla_deadline: rows[0].sla_deadline,
      },
    })

    return reply.status(201).send(rows[0])
  })

  // GET /compliance/erasure — list erasure requests scoped to caller's tenant
  app.get<{ Querystring: { tenant_id?: string; status?: string } }>('/compliance/erasure', async (req, reply) => {
    // tenant_id query param is ignored — always scope to the JWT-derived tenant
    const callerTenantId = (req as any).tenantId as string
    const { status } = req.query

    const conditions: string[] = ['tenant_id = $1']
    const params: unknown[] = [callerTenantId]
    let paramIdx = 2

    if (status) {
      conditions.push(`status = $${paramIdx++}`)
      params.push(status)
    }

    const where = `WHERE ${conditions.join(' AND ')}`

    const { rows } = await app.pg.query<ErasureRequestRow>(
      `SELECT * FROM erasure_requests ${where} ORDER BY requested_at DESC`,
      params,
    )
    return reply.send(rows)
  })

  // GET /compliance/erasure/:id — get a single erasure request, enforce ownership
  app.get<{ Params: { id: string } }>('/compliance/erasure/:id', async (req, reply) => {
    const callerTenantId = (req as any).tenantId as string

    const { rows } = await app.pg.query<ErasureRequestRow>(
      `SELECT * FROM erasure_requests WHERE id = $1`,
      [req.params.id],
    )
    if (!rows.length) return reply.status(404).send({ error: 'erasure request not found' })
    if (rows[0].tenant_id !== callerTenantId) return reply.status(403).send({ error: 'Forbidden' })

    return reply.send(rows[0])
  })

  // POST /compliance/erasure/:id/complete — mark an erasure request as completed, enforce ownership
  // Note: actual physical data deletion is handled by a separate async process.
  // This endpoint records the completion event for audit trail and SLA tracking.
  app.post<{ Params: { id: string } }>('/compliance/erasure/:id/complete', async (req, reply) => {
    const callerTenantId = (req as any).tenantId as string

    // Fetch first to verify ownership before mutating
    const { rows: existing } = await app.pg.query<ErasureRequestRow>(
      `SELECT tenant_id FROM erasure_requests WHERE id = $1`,
      [req.params.id],
    )
    if (!existing.length) {
      return reply.status(404).send({ error: 'erasure request not found or already completed' })
    }
    if (existing[0].tenant_id !== callerTenantId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const { rows } = await app.pg.query<ErasureRequestRow>(
      `UPDATE erasure_requests
       SET completed_at = NOW(), status = 'completed'
       WHERE id = $1 AND status != 'completed'
       RETURNING *`,
      [req.params.id],
    )
    if (!rows.length) {
      return reply.status(404).send({ error: 'erasure request not found or already completed' })
    }

    const request = rows[0]

    await writeAuditEvent(app, {
      tenant_id: request.tenant_id,
      action: 'erasure_completed',
      resource: 'erasure_requests',
      resource_id: request.id,
      metadata: {
        requester_email: request.requester_email,
        full_erasure: request.full_erasure,
        data_categories_deleted: request.data_categories,
        completed_at: request.completed_at,
        note: 'Physical deletion performed by async erasure worker. This event records operator confirmation.',
      },
    })

    return reply.send(request)
  })
}
