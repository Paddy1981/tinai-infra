import { FastifyInstance } from 'fastify'
import { writeAuditEvent } from '../utils/audit'

interface ProcessingActivityRow {
  id: string
  tenant_id: string
  activity_name: string
  purpose: string
  legal_basis: string
  data_categories: string[]
  data_subjects: string[]
  retention_days: number
  processors: string[]
  transfer_regions: string[]
  is_marketing: boolean
  created_at: string
  updated_at: string
}

interface CreateRopaBody {
  tenant_id?: string
  activity_name: string
  purpose: string
  legal_basis: string
  data_categories?: string[]
  data_subjects?: string[]
  retention_days?: number
  processors?: string[]
  transfer_regions?: string[]
  is_marketing?: boolean
}

interface UpdateRopaBody {
  activity_name?: string
  purpose?: string
  legal_basis?: string
  data_categories?: string[]
  data_subjects?: string[]
  retention_days?: number
  processors?: string[]
  transfer_regions?: string[]
  is_marketing?: boolean
}

function arrayToCsvField(arr: string[]): string {
  return arr.join('; ')
}

export async function ropaRoutes(app: FastifyInstance) {
  // GET /compliance/ropa — list processing activities for the caller's tenant only
  app.get<{ Querystring: { tenant_id?: string } }>('/compliance/ropa', async (req, reply) => {
    const callerTenantId = (req as any).tenantId as string
    // tenant_id query param is ignored — always use the JWT-derived tenant
    const { rows } = await app.pg.query<ProcessingActivityRow>(
      `SELECT * FROM processing_activities WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [callerTenantId],
    )
    return reply.send(rows)
  })

  // POST /compliance/ropa — create a processing activity, tenant_id from JWT
  app.post<{ Body: CreateRopaBody }>('/compliance/ropa', {
    schema: {
      body: {
        type: 'object',
        required: ['activity_name', 'purpose', 'legal_basis'],
        properties: {
          tenant_id:        { type: 'string' },
          activity_name:    { type: 'string' },
          purpose:          { type: 'string' },
          legal_basis:      { type: 'string' },
          data_categories:  { type: 'array', items: { type: 'string' } },
          data_subjects:    { type: 'array', items: { type: 'string' } },
          retention_days:   { type: 'number' },
          processors:       { type: 'array', items: { type: 'string' } },
          transfer_regions: { type: 'array', items: { type: 'string' } },
          is_marketing:     { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    // tenant_id is always taken from the JWT — the body field is ignored to prevent spoofing
    const tenant_id = (req as any).tenantId as string
    const {
      activity_name,
      purpose,
      legal_basis,
      data_categories = [],
      data_subjects = [],
      retention_days = 365,
      processors = [],
      transfer_regions = [],
      is_marketing = false,
    } = req.body

    const { rows } = await app.pg.query<ProcessingActivityRow>(
      `INSERT INTO processing_activities
         (tenant_id, activity_name, purpose, legal_basis, data_categories, data_subjects,
          retention_days, processors, transfer_regions, is_marketing)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        tenant_id, activity_name, purpose, legal_basis,
        data_categories, data_subjects, retention_days,
        processors, transfer_regions, is_marketing,
      ],
    )

    await writeAuditEvent(app, {
      tenant_id,
      action: 'ropa_create',
      resource: 'processing_activities',
      resource_id: rows[0].id,
      metadata: { activity_name, legal_basis },
    })

    return reply.status(201).send(rows[0])
  })

  // PUT /compliance/ropa/:id — update processing activity, enforce ownership
  app.put<{ Params: { id: string }; Body: UpdateRopaBody }>('/compliance/ropa/:id', async (req, reply) => {
    const callerTenantId = (req as any).tenantId as string
    const { id } = req.params

    // Fetch existing record first
    const { rows: existing } = await app.pg.query<ProcessingActivityRow>(
      `SELECT * FROM processing_activities WHERE id = $1`,
      [id],
    )
    if (!existing.length) {
      return reply.status(404).send({ error: 'processing activity not found' })
    }

    const current = existing[0]

    // Enforce ownership: only the owning tenant may update
    if (current.tenant_id !== callerTenantId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const {
      activity_name = current.activity_name,
      purpose = current.purpose,
      legal_basis = current.legal_basis,
      data_categories = current.data_categories,
      data_subjects = current.data_subjects,
      retention_days = current.retention_days,
      processors = current.processors,
      transfer_regions = current.transfer_regions,
      is_marketing = current.is_marketing,
    } = req.body

    const { rows } = await app.pg.query<ProcessingActivityRow>(
      `UPDATE processing_activities
       SET activity_name = $1,
           purpose = $2,
           legal_basis = $3,
           data_categories = $4,
           data_subjects = $5,
           retention_days = $6,
           processors = $7,
           transfer_regions = $8,
           is_marketing = $9,
           updated_at = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        activity_name, purpose, legal_basis, data_categories,
        data_subjects, retention_days, processors, transfer_regions,
        is_marketing, id,
      ],
    )

    await writeAuditEvent(app, {
      tenant_id: current.tenant_id,
      action: 'ropa_update',
      resource: 'processing_activities',
      resource_id: id,
      metadata: { activity_name },
    })

    return reply.send(rows[0])
  })

  // GET /compliance/ropa/export — export ROPA as CSV, scoped to caller's tenant
  app.get<{ Querystring: { tenant_id?: string } }>('/compliance/ropa/export', async (req, reply) => {
    // tenant_id query param is ignored — always use the JWT-derived tenant
    const tenantId = (req as any).tenantId as string

    const { rows } = await app.pg.query<ProcessingActivityRow>(
      `SELECT * FROM processing_activities WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    )

    const dateStr = new Date().toISOString().slice(0, 10)
    const filename = `ropa-${tenantId}-${dateStr}.csv`

    const header = [
      'activity_name', 'purpose', 'legal_basis', 'data_categories',
      'data_subjects', 'retention_days', 'processors', 'transfer_regions',
      'is_marketing', 'created_at',
    ].join(',')

    const csvRows = rows.map(row => [
      `"${row.activity_name.replace(/"/g, '""')}"`,
      `"${row.purpose.replace(/"/g, '""')}"`,
      `"${row.legal_basis}"`,
      `"${arrayToCsvField(row.data_categories)}"`,
      `"${arrayToCsvField(row.data_subjects)}"`,
      String(row.retention_days),
      `"${arrayToCsvField(row.processors)}"`,
      `"${arrayToCsvField(row.transfer_regions)}"`,
      String(row.is_marketing),
      `"${row.created_at}"`,
    ].join(','))

    const csv = [header, ...csvRows].join('\n')

    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(csv)
  })
}
