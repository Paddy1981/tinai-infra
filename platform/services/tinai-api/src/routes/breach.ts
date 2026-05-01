import Anthropic from '@anthropic-ai/sdk'
import { FastifyInstance } from 'fastify'
import { writeAuditEvent } from '../utils/audit'

interface BreachIncidentRow {
  id: string
  tenant_id: string | null
  region: string
  detected_at: string
  description: string | null
  affected_categories: string[]
  affected_records: number
  status: string
  notification_draft: Record<string, unknown> | null
  regulator_notified_at: string | null
  principals_notified_at: string | null
  resolved_at: string | null
  created_by: string
}

interface BreachIncidentComputed extends BreachIncidentRow {
  hours_remaining: number
  deadline_passed: boolean
}

interface CreateBreachBody {
  description?: string
  affected_categories?: string[]
  affected_records?: number
  region?: string
  tenant_id?: string
}

const BREACH_NOTIFICATION_SYSTEM_PROMPT =
  'You are a data protection officer assistant. Generate a concise, formal regulator notification for a data breach. ' +
  'Format as JSON with keys: subject, body, recommended_actions. ' +
  'Follow DPDP 2023 (India), PDPPL 2016 (Qatar), or PDPL 2021 (UAE) format based on the region field.'

const NOTIFICATION_DRAFT_STUB = {
  subject: '[TEMPLATE] Data Breach Notification',
  body: 'This is a template notification. Please populate with incident details and submit within 72 hours of detection.',
  recommended_actions: [
    'Contain the breach immediately',
    'Assess affected data categories and record count',
    'Notify the relevant data protection authority within 72 hours',
    'Notify affected data principals if high risk',
  ],
}

function computeBreachFields(row: BreachIncidentRow): BreachIncidentComputed {
  const detectedAt = new Date(row.detected_at)
  const hoursSinceDetection = (Date.now() - detectedAt.getTime()) / 3_600_000
  const hours_remaining = Math.max(0, Math.round((72 - hoursSinceDetection) * 10) / 10)
  const deadline_passed = hoursSinceDetection > 72
  return { ...row, hours_remaining, deadline_passed }
}

async function generateNotificationDraft(
  description: string | undefined,
  affectedCategories: string[],
  affectedRecords: number,
  region: string,
): Promise<Record<string, unknown>> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NOTIFICATION_DRAFT_STUB
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const userMessage =
      `Region: ${region}\n` +
      `Description: ${description ?? 'Not provided'}\n` +
      `Affected data categories: ${affectedCategories.join(', ') || 'Unknown'}\n` +
      `Estimated affected records: ${affectedRecords}\n\n` +
      `Generate the formal regulator notification draft as JSON.`

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: BREACH_NOTIFICATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })

    const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
    // Extract JSON from the response (Claude may wrap it in markdown code fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>
    }
    return { subject: text, body: '', recommended_actions: [] }
  } catch {
    return NOTIFICATION_DRAFT_STUB
  }
}

export async function breachRoutes(app: FastifyInstance) {
  // POST /compliance/breach — create a new breach incident, tenant_id from JWT
  app.post<{ Body: CreateBreachBody }>('/compliance/breach', {
    schema: {
      body: {
        type: 'object',
        properties: {
          description:         { type: 'string' },
          affected_categories: { type: 'array', items: { type: 'string' } },
          affected_records:    { type: 'number' },
          region:              { type: 'string' },
          tenant_id:           { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    // tenant_id is always taken from the JWT — the body field is ignored to prevent spoofing
    const tenant_id = (req as any).tenantId as string
    const {
      description,
      affected_categories = [],
      affected_records = 0,
      region = 'IN',
    } = req.body

    // Generate notification draft (calls Claude if API key present, else returns stub)
    const notification_draft = await generateNotificationDraft(
      description,
      affected_categories,
      affected_records,
      region,
    )

    const { rows } = await app.pg.query<BreachIncidentRow>(
      `INSERT INTO breach_incidents
         (tenant_id, region, description, affected_categories, affected_records,
          status, notification_draft)
       VALUES ($1, $2, $3, $4, $5, 'detected', $6)
       RETURNING *`,
      [
        tenant_id,
        region,
        description ?? null,
        affected_categories,
        affected_records,
        JSON.stringify(notification_draft),
      ],
    )

    await writeAuditEvent(app, {
      tenant_id,
      action: 'breach_detected',
      resource: 'breach_incidents',
      resource_id: rows[0].id,
      region,
      metadata: { affected_records, affected_categories, status: 'detected' },
    })

    return reply.status(201).send(computeBreachFields(rows[0]))
  })

  // GET /compliance/breach — list incidents for the caller's tenant only
  app.get('/compliance/breach', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { rows } = await app.pg.query<BreachIncidentRow>(
      `SELECT * FROM breach_incidents WHERE tenant_id = $1 ORDER BY detected_at DESC`,
      [tenantId],
    )
    return reply.send(rows.map(computeBreachFields))
  })

  // GET /compliance/breach/:id — get single incident, enforce ownership
  app.get<{ Params: { id: string } }>('/compliance/breach/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { rows } = await app.pg.query<BreachIncidentRow>(
      `SELECT * FROM breach_incidents WHERE id = $1`,
      [req.params.id],
    )
    if (!rows.length) return reply.status(404).send({ error: 'breach incident not found' })
    if (rows[0].tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })
    return reply.send(computeBreachFields(rows[0]))
  })

  // POST /compliance/breach/:id/notify-regulator — enforce ownership
  app.post<{ Params: { id: string } }>('/compliance/breach/:id/notify-regulator', async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    // Fetch first to verify ownership before mutating
    const { rows: existing } = await app.pg.query<BreachIncidentRow>(
      `SELECT tenant_id FROM breach_incidents WHERE id = $1`,
      [req.params.id],
    )
    if (!existing.length) return reply.status(404).send({ error: 'breach incident not found' })
    if (existing[0].tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query<BreachIncidentRow>(
      `UPDATE breach_incidents
       SET regulator_notified_at = NOW(), status = 'notified'
       WHERE id = $1
       RETURNING *`,
      [req.params.id],
    )
    if (!rows.length) return reply.status(404).send({ error: 'breach incident not found' })

    await writeAuditEvent(app, {
      tenant_id: rows[0].tenant_id ?? tenantId,
      action: 'breach_regulator_notified',
      resource: 'breach_incidents',
      resource_id: rows[0].id,
      region: rows[0].region,
      metadata: { regulator_notified_at: rows[0].regulator_notified_at },
    })

    return reply.send(computeBreachFields(rows[0]))
  })

  // POST /compliance/breach/:id/resolve — enforce ownership
  app.post<{ Params: { id: string } }>('/compliance/breach/:id/resolve', async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    // Fetch first to verify ownership before mutating
    const { rows: existing } = await app.pg.query<BreachIncidentRow>(
      `SELECT tenant_id FROM breach_incidents WHERE id = $1`,
      [req.params.id],
    )
    if (!existing.length) return reply.status(404).send({ error: 'breach incident not found' })
    if (existing[0].tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query<BreachIncidentRow>(
      `UPDATE breach_incidents
       SET resolved_at = NOW(), status = 'closed'
       WHERE id = $1
       RETURNING *`,
      [req.params.id],
    )
    if (!rows.length) return reply.status(404).send({ error: 'breach incident not found' })

    await writeAuditEvent(app, {
      tenant_id: rows[0].tenant_id ?? tenantId,
      action: 'breach_resolved',
      resource: 'breach_incidents',
      resource_id: rows[0].id,
      region: rows[0].region,
      metadata: { resolved_at: rows[0].resolved_at, status: 'closed' },
    })

    return reply.send(computeBreachFields(rows[0]))
  })
}
