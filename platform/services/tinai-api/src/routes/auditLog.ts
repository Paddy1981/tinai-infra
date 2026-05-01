/*
 * Audit Log routes — immutable event log for tenant activity
 *
 * Equivalent to Vercel's audit log, Supabase's auth.audit_log_entries.
 *
 * Requires: 019_audit_log.sql
 */

import { FastifyInstance } from 'fastify'

export async function auditLogRoutes(app: FastifyInstance) {

  // -------------------------------------------------------------------------
  // List audit events (paginated, filterable)
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: {
      action?: string
      actor_id?: string
      resource?: string
      from?: string
      to?: string
      limit?: number
      offset?: number
    }
  }>('/audit-log', async (req) => {
    const tenantId = (req as any).tenantId
    const { action, actor_id, resource, from, to, limit = 50, offset = 0 } = req.query

    const conditions: string[] = ['tenant_id = $1']
    const params: any[] = [tenantId]
    let idx = 2

    if (action) {
      conditions.push(`action LIKE $${idx}`)
      params.push(`${action}%`)
      idx++
    }
    if (actor_id) {
      conditions.push(`actor_id = $${idx}`)
      params.push(actor_id)
      idx++
    }
    if (resource) {
      conditions.push(`resource LIKE $${idx}`)
      params.push(`${resource}%`)
      idx++
    }
    if (from) {
      conditions.push(`created_at >= $${idx}`)
      params.push(from)
      idx++
    }
    if (to) {
      conditions.push(`created_at <= $${idx}`)
      params.push(to)
      idx++
    }

    const where = conditions.join(' AND ')

    const [countResult, dataResult] = await Promise.all([
      app.pg.query(`SELECT COUNT(*) FROM audit_log WHERE ${where}`, params),
      app.pg.query(
        `SELECT al.id, al.action, al.resource, al.actor_email, al.ip_address,
                al.metadata, al.created_at, u.display_name AS actor_name
           FROM audit_log al
           LEFT JOIN users u ON u.id = al.actor_id
          WHERE ${where}
          ORDER BY al.created_at DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, Math.min(limit, 100), offset],
      ),
    ])

    return {
      total: parseInt(countResult.rows[0].count),
      data: dataResult.rows,
    }
  })

  // -------------------------------------------------------------------------
  // Export audit log (CSV format for compliance)
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: { from?: string; to?: string }
  }>('/audit-log/export', async (req, reply) => {
    const tenantId = (req as any).tenantId
    const { from, to } = req.query

    const conditions: string[] = ['tenant_id = $1']
    const params: any[] = [tenantId]
    let idx = 2

    if (from) { conditions.push(`created_at >= $${idx}`); params.push(from); idx++ }
    if (to) { conditions.push(`created_at <= $${idx}`); params.push(to); idx++ }

    const { rows } = await app.pg.query(
      `SELECT id, action, resource, actor_email, ip_address, metadata, created_at
         FROM audit_log WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC LIMIT 10000`,
      params,
    )

    const csv = [
      'id,action,resource,actor_email,ip_address,metadata,created_at',
      ...rows.map(r =>
        `${r.id},"${r.action}","${r.resource || ''}","${r.actor_email || ''}","${r.ip_address || ''}","${JSON.stringify(r.metadata).replace(/"/g, '""')}","${r.created_at}"`,
      ),
    ].join('\n')

    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`)
    return reply.send(csv)
  })
}

// -------------------------------------------------------------------------
// Helper: log an audit event (call from other routes)
// -------------------------------------------------------------------------
export async function logAuditEvent(
  pg: any,
  opts: {
    tenantId: string
    teamId?: string
    actorId?: string
    actorEmail?: string
    action: string
    resource?: string
    metadata?: Record<string, any>
    ipAddress?: string
    userAgent?: string
  },
) {
  await pg.query(
    `INSERT INTO audit_log (tenant_id, team_id, actor_id, actor_email, action, resource, metadata, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9)`,
    [
      opts.tenantId, opts.teamId || null, opts.actorId || null, opts.actorEmail || null,
      opts.action, opts.resource || null, JSON.stringify(opts.metadata || {}),
      opts.ipAddress || null, opts.userAgent || null,
    ],
  )
}
