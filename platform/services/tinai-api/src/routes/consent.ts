import { FastifyInstance } from 'fastify'
import { writeAuditEvent } from '../utils/audit'

interface ConsentBody {
  tenant_id: string
  purpose: string
  legal_basis: string
  granted: boolean
  ip_address?: string
  user_agent?: string
  notice_version?: string
  region?: string
}

interface ConsentRow {
  id: string
  tenant_id: string
  purpose: string
  legal_basis: string
  granted: boolean
  ip_address: string | null
  user_agent: string | null
  notice_version: string
  region: string
  granted_at: string
  withdrawn_at: string | null
}

export async function consentRoutes(app: FastifyInstance) {
  // POST /compliance/consent — record a new consent, tenant_id forced from JWT
  app.post<{ Body: ConsentBody }>('/compliance/consent', {
    schema: {
      body: {
        type: 'object',
        required: ['tenant_id', 'purpose', 'legal_basis', 'granted'],
        properties: {
          tenant_id:      { type: 'string' },
          purpose:        { type: 'string' },
          legal_basis:    { type: 'string' },
          granted:        { type: 'boolean' },
          ip_address:     { type: 'string' },
          user_agent:     { type: 'string' },
          notice_version: { type: 'string' },
          region:         { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const callerTenantId = (req as any).tenantId as string
    const {
      purpose,
      legal_basis,
      granted,
      ip_address,
      user_agent,
      notice_version = '1.0',
      region = 'IN',
    } = req.body

    // tenant_id is always taken from the JWT — the body field is ignored to prevent spoofing
    const tenant_id = callerTenantId

    const { rows } = await app.pg.query<ConsentRow>(
      `INSERT INTO consent_records
         (tenant_id, purpose, legal_basis, granted, ip_address, user_agent, notice_version, region)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tenant_id, purpose, legal_basis, granted, ip_address ?? null, user_agent ?? null, notice_version, region],
    )

    await writeAuditEvent(app, {
      tenant_id,
      action: 'consent_record',
      resource: 'consent_records',
      resource_id: rows[0].id,
      ip_address: ip_address ?? null,
      region,
      metadata: { purpose, legal_basis, granted, notice_version },
    })

    return reply.status(201).send(rows[0])
  })

  // GET /compliance/consent/:tenantId — list consent records, enforce ownership
  app.get<{ Params: { tenantId: string } }>('/compliance/consent/:tenantId', async (req, reply) => {
    const callerTenantId = (req as any).tenantId as string
    if (req.params.tenantId !== callerTenantId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const { rows } = await app.pg.query<ConsentRow>(
      `SELECT * FROM consent_records WHERE tenant_id = $1 ORDER BY granted_at DESC`,
      [callerTenantId],
    )
    return reply.send(rows)
  })

  // POST /compliance/consent/:id/withdraw — withdraw consent, enforce ownership
  app.post<{ Params: { id: string } }>('/compliance/consent/:id/withdraw', async (req, reply) => {
    const callerTenantId = (req as any).tenantId as string

    // Fetch the record first to verify ownership before mutating
    const { rows: existing } = await app.pg.query<ConsentRow>(
      `SELECT * FROM consent_records WHERE id = $1`,
      [req.params.id],
    )
    if (!existing.length) {
      return reply.status(404).send({ error: 'consent record not found or already withdrawn' })
    }
    if (existing[0].tenant_id !== callerTenantId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const { rows } = await app.pg.query<ConsentRow>(
      `UPDATE consent_records
       SET withdrawn_at = NOW(), granted = false
       WHERE id = $1 AND withdrawn_at IS NULL
       RETURNING *`,
      [req.params.id],
    )

    if (!rows.length) {
      return reply.status(404).send({ error: 'consent record not found or already withdrawn' })
    }

    await writeAuditEvent(app, {
      tenant_id: rows[0].tenant_id,
      action: 'consent_withdraw',
      resource: 'consent_records',
      resource_id: rows[0].id,
      region: rows[0].region,
      metadata: { purpose: rows[0].purpose },
    })

    return reply.send(rows[0])
  })

  // GET /compliance/consent/status/:tenantId — per-purpose consent summary, enforce ownership
  app.get<{ Params: { tenantId: string } }>('/compliance/consent/status/:tenantId', async (req, reply) => {
    const callerTenantId = (req as any).tenantId as string
    if (req.params.tenantId !== callerTenantId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const { rows } = await app.pg.query(
      `SELECT DISTINCT ON (purpose)
         purpose,
         granted,
         granted_at,
         withdrawn_at
       FROM consent_records
       WHERE tenant_id = $1
       ORDER BY purpose, granted_at DESC`,
      [callerTenantId],
    )
    return reply.send(rows)
  })
}
