/*
 * Usage Analytics & Cost Projections routes
 *
 * Equivalent to Vercel Usage tab, Railway Metrics, Supabase Usage page.
 *
 * Requires: 020_usage_analytics.sql
 */

import { FastifyInstance } from 'fastify'

export async function usageAnalyticsRoutes(app: FastifyInstance) {

  // -------------------------------------------------------------------------
  // Current period usage summary
  // -------------------------------------------------------------------------
  app.get('/usage/summary', async (req) => {
    const tenantId = (req as any).tenantId

    const { rows } = await app.pg.query(
      `SELECT
         COALESCE(SUM(cpu_seconds), 0)::numeric AS total_cpu_seconds,
         COALESCE(SUM(memory_gb_seconds), 0)::numeric AS total_memory_gb_seconds,
         COALESCE(SUM(bandwidth_bytes), 0)::bigint AS total_bandwidth_bytes,
         COALESCE(SUM(request_count), 0)::bigint AS total_requests,
         COALESCE(SUM(build_minutes), 0)::numeric AS total_build_minutes,
         COALESCE(SUM(ai_tokens_in + ai_tokens_out), 0)::bigint AS total_ai_tokens
       FROM usage_hourly
       WHERE tenant_id = $1
         AND hour >= date_trunc('month', NOW())`,
      [tenantId],
    )

    // Get plan limits for context
    const { rows: plan } = await app.pg.query(
      `SELECT p.limits FROM tenant_plans tp JOIN plans p ON p.id = tp.plan_id WHERE tp.tenant_id = $1`,
      [tenantId],
    )

    return {
      period: {
        start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
        end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString(),
      },
      usage: rows[0],
      limits: plan[0]?.limits || {},
    }
  })

  // -------------------------------------------------------------------------
  // Hourly usage chart data (for graphs)
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: { from?: string; to?: string; project_id?: string; metric?: string }
  }>('/usage/timeseries', async (req) => {
    const tenantId = (req as any).tenantId
    const {
      from = new Date(Date.now() - 7 * 86400000).toISOString(),
      to = new Date().toISOString(),
      project_id,
      metric = 'cpu_seconds',
    } = req.query

    const validMetrics = ['cpu_seconds', 'memory_gb_seconds', 'bandwidth_bytes', 'request_count', 'build_minutes', 'ai_tokens_in', 'ai_tokens_out']
    const col = validMetrics.includes(metric) ? metric : 'cpu_seconds'

    const conditions = ['tenant_id = $1', 'hour >= $2', 'hour <= $3']
    const params: any[] = [tenantId, from, to]

    if (project_id) {
      conditions.push('project_id = $4')
      params.push(project_id)
    }

    const { rows } = await app.pg.query(
      `SELECT hour, COALESCE(SUM(${col}), 0) AS value
         FROM usage_hourly
        WHERE ${conditions.join(' AND ')}
        GROUP BY hour
        ORDER BY hour`,
      params,
    )

    return { metric: col, data: rows }
  })

  // -------------------------------------------------------------------------
  // Cost breakdown (current month)
  // -------------------------------------------------------------------------
  app.get('/usage/costs', async (req) => {
    const tenantId = (req as any).tenantId

    const { rows } = await app.pg.query(
      `SELECT day, compute_inr, storage_inr, bandwidth_inr, ai_inr, total_inr
         FROM cost_daily
        WHERE tenant_id = $1 AND day >= date_trunc('month', CURRENT_DATE)
        ORDER BY day`,
      [tenantId],
    )

    const totals = rows.reduce(
      (acc, r) => ({
        compute: acc.compute + parseFloat(r.compute_inr),
        storage: acc.storage + parseFloat(r.storage_inr),
        bandwidth: acc.bandwidth + parseFloat(r.bandwidth_inr),
        ai: acc.ai + parseFloat(r.ai_inr),
        total: acc.total + parseFloat(r.total_inr),
      }),
      { compute: 0, storage: 0, bandwidth: 0, ai: 0, total: 0 },
    )

    // Simple projection: (total so far / days elapsed) * days in month
    const dayOfMonth = new Date().getDate()
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
    const projectedTotal = dayOfMonth > 0 ? (totals.total / dayOfMonth) * daysInMonth : 0

    return {
      daily: rows,
      month_to_date: totals,
      projected_total_inr: Math.round(projectedTotal * 100) / 100,
      days_remaining: daysInMonth - dayOfMonth,
    }
  })

  // -------------------------------------------------------------------------
  // Per-project usage breakdown
  // -------------------------------------------------------------------------
  app.get('/usage/by-project', async (req) => {
    const tenantId = (req as any).tenantId

    const { rows } = await app.pg.query(
      `SELECT p.id, p.name, p.slug,
              COALESCE(SUM(uh.cpu_seconds), 0)::numeric AS cpu_seconds,
              COALESCE(SUM(uh.memory_gb_seconds), 0)::numeric AS memory_gb_seconds,
              COALESCE(SUM(uh.request_count), 0)::bigint AS requests,
              COALESCE(SUM(uh.bandwidth_bytes), 0)::bigint AS bandwidth_bytes
         FROM projects p
         LEFT JOIN usage_hourly uh ON uh.project_id = p.id AND uh.hour >= date_trunc('month', NOW())
        WHERE p.tenant_id = $1
        GROUP BY p.id, p.name, p.slug
        ORDER BY cpu_seconds DESC`,
      [tenantId],
    )

    return rows
  })

  // -------------------------------------------------------------------------
  // Spending alerts CRUD
  // -------------------------------------------------------------------------
  app.get('/usage/alerts', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT * FROM spending_alerts WHERE tenant_id = $1 ORDER BY threshold_inr`,
      [tenantId],
    )
    return rows
  })

  app.post<{ Body: { threshold_inr: number; period?: string; notify_webhook?: string } }>(
    '/usage/alerts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['threshold_inr'],
          properties: {
            threshold_inr:  { type: 'number', minimum: 1 },
            period:         { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            notify_webhook: { type: 'string', format: 'uri' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { threshold_inr, period = 'monthly', notify_webhook } = req.body

      const { rows } = await app.pg.query(
        `INSERT INTO spending_alerts (tenant_id, threshold_inr, period, notify_webhook)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [tenantId, threshold_inr, period, notify_webhook || null],
      )
      return reply.status(201).send(rows[0])
    },
  )

  app.delete<{ Params: { id: string } }>('/usage/alerts/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId
    await app.pg.query(
      `DELETE FROM spending_alerts WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    )
    return reply.status(204).send()
  })
}
