/*
 * Observability routes — Vercel Observability (Query, Notebooks, Alerts) equivalent
 * Also covers Analytics and Speed Insights.
 *
 * Requires: 027_observability_and_analytics.sql
 */

import { FastifyInstance } from 'fastify'

export async function observabilityRoutes(app: FastifyInstance) {

  // =========================================================================
  // SAVED QUERIES
  // =========================================================================

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/observability/queries', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT * FROM observability_queries
        WHERE tenant_id = $1 AND (project_id = $2 OR project_id IS NULL)
        ORDER BY name`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  app.post<{
    Params: { projectId: string }
    Body: { name: string; query_type: string; query: string; visualization?: string; time_range?: string; description?: string }
  }>(
    '/projects/:projectId/observability/queries',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).userId
      const { name, query_type, query, visualization = 'table', time_range = '1h', description } = req.body

      const { rows } = await app.pg.query(
        `INSERT INTO observability_queries (tenant_id, project_id, name, description, query_type, query, visualization, time_range, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [tenantId, req.params.projectId, name, description || null, query_type, query, visualization, time_range, userId],
      )
      return reply.status(201).send(rows[0])
    },
  )

  // Execute a query against Loki/Prometheus (proxy)
  app.post<{ Body: { query: string; query_type: string; start?: string; end?: string; limit?: number } }>(
    '/observability/execute',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { query, query_type, start, end, limit = 100 } = req.body

      // Inject tenant label for isolation
      const tenantQuery = query_type === 'logs'
        ? query.replace('{', `{tenant_id="${tenantId}",`)
        : query.replace('{', `{tenant_id="${tenantId}",`)

      const baseUrl = query_type === 'logs'
        ? (process.env.LOKI_URL || 'http://loki.monitoring.svc.cluster.local:3100')
        : (process.env.PROMETHEUS_URL || 'http://prometheus.monitoring.svc.cluster.local:9090')

      const endpoint = query_type === 'logs'
        ? '/loki/api/v1/query_range'
        : '/api/v1/query_range'

      try {
        const params = new URLSearchParams({
          query: tenantQuery,
          start: start || new Date(Date.now() - 3600000).toISOString(),
          end: end || new Date().toISOString(),
          limit: String(limit),
        })

        const resp = await fetch(`${baseUrl}${endpoint}?${params}`, {
          signal: AbortSignal.timeout(30000),
        })
        const data = await resp.json()
        return data
      } catch (e: any) {
        return reply.status(502).send({ error: 'Observability backend unavailable', detail: e.message })
      }
    },
  )

  // =========================================================================
  // NOTEBOOKS
  // =========================================================================

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/observability/notebooks', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT id, title, description, created_by, is_shared, created_at, updated_at
         FROM observability_notebooks
        WHERE tenant_id = $1 AND (project_id = $2 OR project_id IS NULL)
        ORDER BY updated_at DESC`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  app.get<{ Params: { notebookId: string } }>('/observability/notebooks/:notebookId', async (req, reply) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT * FROM observability_notebooks WHERE id = $1 AND tenant_id = $2`,
      [req.params.notebookId, tenantId],
    )
    if (!rows.length) return reply.status(404).send({ error: 'Notebook not found' })
    return rows[0]
  })

  app.post<{
    Params: { projectId: string }
    Body: { title: string; description?: string; cells?: any[] }
  }>(
    '/projects/:projectId/observability/notebooks',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).userId
      const { title, description, cells = [] } = req.body

      const { rows } = await app.pg.query(
        `INSERT INTO observability_notebooks (tenant_id, project_id, title, description, cells, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenantId, req.params.projectId, title, description || null, JSON.stringify(cells), userId],
      )
      return reply.status(201).send(rows[0])
    },
  )

  app.put<{ Params: { notebookId: string }; Body: { title?: string; cells?: any[] } }>(
    '/observability/notebooks/:notebookId',
    async (req) => {
      const tenantId = (req as any).tenantId
      const { title, cells } = req.body
      const { rows } = await app.pg.query(
        `UPDATE observability_notebooks SET
           title = COALESCE($3, title),
           cells = COALESCE($4, cells),
           updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.notebookId, tenantId, title, cells ? JSON.stringify(cells) : null],
      )
      return rows[0]
    },
  )

  // =========================================================================
  // ALERTS
  // =========================================================================

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/alerts', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT ar.*,
              (SELECT COUNT(*) FROM alert_incidents ai WHERE ai.rule_id = ar.id AND ai.status = 'firing') AS active_incidents
         FROM alert_rules ar
        WHERE ar.tenant_id = $1 AND (ar.project_id = $2 OR ar.project_id IS NULL)
        ORDER BY ar.severity DESC, ar.name`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  app.post<{
    Params: { projectId: string }
    Body: { name: string; description?: string; condition: any; channels: any[]; severity?: string; cooldown_minutes?: number }
  }>(
    '/projects/:projectId/alerts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'condition', 'channels'],
          properties: {
            name:        { type: 'string', minLength: 1 },
            description: { type: 'string' },
            condition:   { type: 'object' },
            channels:    { type: 'array', minItems: 1 },
            severity:    { type: 'string', enum: ['info', 'warning', 'critical'] },
            cooldown_minutes: { type: 'integer', minimum: 5 },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { name, description, condition, channels, severity = 'warning', cooldown_minutes = 30 } = req.body

      const { rows } = await app.pg.query(
        `INSERT INTO alert_rules (tenant_id, project_id, name, description, condition, channels, severity, cooldown_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [tenantId, req.params.projectId, name, description || null,
         JSON.stringify(condition), JSON.stringify(channels), severity, cooldown_minutes],
      )
      return reply.status(201).send(rows[0])
    },
  )

  // Alert incidents
  app.get<{ Params: { alertId: string } }>('/alerts/:alertId/incidents', async (req) => {
    const { rows } = await app.pg.query(
      `SELECT * FROM alert_incidents WHERE rule_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.alertId],
    )
    return rows
  })

  // Acknowledge incident
  app.put<{ Params: { incidentId: string } }>('/alerts/incidents/:incidentId/acknowledge', async (req) => {
    const userId = (req as any).userId
    const { rows } = await app.pg.query(
      `UPDATE alert_incidents SET status = 'acknowledged', acknowledged_by = $2 WHERE id = $1 RETURNING *`,
      [req.params.incidentId, userId],
    )
    return rows[0]
  })

  // =========================================================================
  // WEB ANALYTICS & SPEED INSIGHTS
  // =========================================================================

  // Ingest analytics beacon (called by client-side script)
  app.post<{ Body: { project_id: string; path: string; referrer?: string; country?: string; device?: string; browser?: string; metrics?: any } }>(
    '/analytics/ingest',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { project_id, path, referrer, country, device, browser, metrics = {} } = req.body
      const hour = new Date().toISOString().replace(/:\d{2}:\d{2}\.\d+Z/, ':00:00.000Z')

      await app.pg.query(
        `INSERT INTO web_analytics (tenant_id, project_id, hour, path, page_views, unique_visitors,
           avg_fcp_ms, avg_lcp_ms, avg_cls, avg_inp_ms, avg_ttfb_ms, referrer, country, device, browser)
         VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (tenant_id, project_id, hour, path, country, device)
         DO UPDATE SET
           page_views = web_analytics.page_views + 1,
           avg_fcp_ms = (web_analytics.avg_fcp_ms * web_analytics.page_views + COALESCE($5, 0)) / (web_analytics.page_views + 1),
           avg_lcp_ms = (web_analytics.avg_lcp_ms * web_analytics.page_views + COALESCE($6, 0)) / (web_analytics.page_views + 1)`,
        [tenantId, project_id, hour, path,
         metrics.fcp || null, metrics.lcp || null, metrics.cls || null, metrics.inp || null, metrics.ttfb || null,
         referrer || null, country || null, device || null, browser || null],
      )
      return reply.status(202).send({ ok: true })
    },
  )

  // Analytics dashboard data
  app.get<{
    Params: { projectId: string }
    Querystring: { from?: string; to?: string; group_by?: string }
  }>('/projects/:projectId/analytics', async (req) => {
    const tenantId = (req as any).tenantId
    const {
      from = new Date(Date.now() - 7 * 86400000).toISOString(),
      to = new Date().toISOString(),
      group_by = 'path',
    } = req.query

    const groupCol = ['path', 'country', 'device', 'browser', 'referrer'].includes(group_by) ? group_by : 'path'

    const { rows } = await app.pg.query(
      `SELECT ${groupCol},
              SUM(page_views)::bigint AS page_views,
              SUM(unique_visitors)::bigint AS unique_visitors,
              AVG(avg_lcp_ms)::integer AS avg_lcp_ms,
              AVG(avg_fcp_ms)::integer AS avg_fcp_ms,
              AVG(avg_cls)::numeric(5,3) AS avg_cls,
              AVG(avg_ttfb_ms)::integer AS avg_ttfb_ms
         FROM web_analytics
        WHERE tenant_id = $1 AND project_id = $2 AND hour BETWEEN $3 AND $4
        GROUP BY ${groupCol}
        ORDER BY page_views DESC
        LIMIT 100`,
      [tenantId, req.params.projectId, from, to],
    )

    // Also get timeseries for chart
    const { rows: timeseries } = await app.pg.query(
      `SELECT date_trunc('day', hour) AS day,
              SUM(page_views)::bigint AS page_views,
              SUM(unique_visitors)::bigint AS unique_visitors
         FROM web_analytics
        WHERE tenant_id = $1 AND project_id = $2 AND hour BETWEEN $3 AND $4
        GROUP BY day ORDER BY day`,
      [tenantId, req.params.projectId, from, to],
    )

    return { breakdown: rows, timeseries }
  })

  // Speed Insights (Core Web Vitals)
  app.get<{ Params: { projectId: string }; Querystring: { from?: string; to?: string } }>(
    '/projects/:projectId/speed-insights',
    async (req) => {
      const tenantId = (req as any).tenantId
      const { from = new Date(Date.now() - 7 * 86400000).toISOString(), to = new Date().toISOString() } = req.query

      const { rows } = await app.pg.query(
        `SELECT
           AVG(avg_fcp_ms)::integer AS fcp_ms,
           AVG(avg_lcp_ms)::integer AS lcp_ms,
           AVG(avg_cls)::numeric(5,3) AS cls,
           AVG(avg_inp_ms)::integer AS inp_ms,
           AVG(avg_ttfb_ms)::integer AS ttfb_ms,
           SUM(page_views)::bigint AS total_page_views
         FROM web_analytics
        WHERE tenant_id = $1 AND project_id = $2 AND hour BETWEEN $3 AND $4`,
        [tenantId, req.params.projectId, from, to],
      )

      const cwv = rows[0] || {}
      return {
        ...cwv,
        scores: {
          fcp: cwv.fcp_ms <= 1800 ? 'good' : cwv.fcp_ms <= 3000 ? 'needs-improvement' : 'poor',
          lcp: cwv.lcp_ms <= 2500 ? 'good' : cwv.lcp_ms <= 4000 ? 'needs-improvement' : 'poor',
          cls: parseFloat(cwv.cls) <= 0.1 ? 'good' : parseFloat(cwv.cls) <= 0.25 ? 'needs-improvement' : 'poor',
          inp: cwv.inp_ms <= 200 ? 'good' : cwv.inp_ms <= 500 ? 'needs-improvement' : 'poor',
          ttfb: cwv.ttfb_ms <= 800 ? 'good' : cwv.ttfb_ms <= 1800 ? 'needs-improvement' : 'poor',
        },
      }
    },
  )
}
