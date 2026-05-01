/*
 * Cron Jobs & Job Queues routes — Vercel Cron + Queues equivalent
 *
 * Scheduled tasks and persistent job queues with retry and dead-letter.
 *
 * Requires: 026_queues_and_cron.sql
 */

import { FastifyInstance } from 'fastify'

export async function cronJobsRoutes(app: FastifyInstance) {

  // =========================================================================
  // CRON JOBS
  // =========================================================================

  // List cron jobs
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/cron', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT id, name, schedule, timezone, endpoint_url, http_method, enabled,
              last_run, next_run, last_status, created_at
         FROM cron_jobs WHERE tenant_id = $1 AND project_id = $2 ORDER BY name`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  // Create cron job
  app.post<{
    Params: { projectId: string }
    Body: { name: string; schedule: string; endpoint_url: string; timezone?: string; http_method?: string; headers?: any; body?: any }
  }>(
    '/projects/:projectId/cron',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'schedule', 'endpoint_url'],
          properties: {
            name:         { type: 'string', minLength: 1 },
            schedule:     { type: 'string', minLength: 1 },  // cron expression
            endpoint_url: { type: 'string', format: 'uri' },
            timezone:     { type: 'string' },
            http_method:  { type: 'string', enum: ['GET', 'POST', 'PUT'] },
            headers:      { type: 'object' },
            body:         {},
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { name, schedule, endpoint_url, timezone = 'UTC', http_method = 'POST', headers, body } = req.body

      // Calculate next_run from cron expression (simplified: use current time + 1 interval)
      const { rows } = await app.pg.query(
        `INSERT INTO cron_jobs (tenant_id, project_id, name, schedule, timezone, endpoint_url, http_method, headers, body, next_run)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + interval '1 hour')
         RETURNING *`,
        [tenantId, req.params.projectId, name, schedule, timezone, endpoint_url, http_method,
         headers ? JSON.stringify(headers) : '{}', body ? JSON.stringify(body) : null],
      )
      return reply.status(201).send(rows[0])
    },
  )

  // Toggle cron job
  app.put<{ Params: { projectId: string; cronId: string }; Body: { enabled?: boolean; schedule?: string } }>(
    '/projects/:projectId/cron/:cronId',
    async (req, reply) => {
      const { enabled, schedule } = req.body
      const { rows } = await app.pg.query(
        `UPDATE cron_jobs SET
           enabled = COALESCE($3, enabled),
           schedule = COALESCE($4, schedule)
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.cronId, (req as any).tenantId, enabled ?? null, schedule ?? null],
      )
      if (!rows.length) return reply.status(404).send({ error: 'Cron job not found' })
      return rows[0]
    },
  )

  // Trigger cron job manually
  app.post<{ Params: { projectId: string; cronId: string } }>(
    '/projects/:projectId/cron/:cronId/trigger',
    async (req, reply) => {
      const { rows } = await app.pg.query(
        `SELECT * FROM cron_jobs WHERE id = $1 AND tenant_id = $2`,
        [req.params.cronId, (req as any).tenantId],
      )
      if (!rows.length) return reply.status(404).send({ error: 'Cron job not found' })

      const cron = rows[0]
      const start = Date.now()
      try {
        const resp = await fetch(cron.endpoint_url, {
          method: cron.http_method,
          headers: { 'Content-Type': 'application/json', ...cron.headers },
          body: cron.body ? JSON.stringify(cron.body) : undefined,
          signal: AbortSignal.timeout(cron.timeout_seconds || 30000),
        })
        const duration = Date.now() - start

        await app.pg.query(
          `INSERT INTO cron_executions (cron_id, status_code, duration_ms) VALUES ($1, $2, $3)`,
          [cron.id, resp.status, duration],
        )
        await app.pg.query(`UPDATE cron_jobs SET last_run = NOW(), last_status = $2 WHERE id = $1`, [cron.id, resp.status])

        return { triggered: true, status: resp.status, duration_ms: duration }
      } catch (e: any) {
        const duration = Date.now() - start
        await app.pg.query(
          `INSERT INTO cron_executions (cron_id, status_code, error, duration_ms) VALUES ($1, 0, $2, $3)`,
          [cron.id, e.message, duration],
        )
        return reply.status(502).send({ error: e.message })
      }
    },
  )

  // Cron execution history
  app.get<{ Params: { projectId: string; cronId: string } }>(
    '/projects/:projectId/cron/:cronId/history',
    async (req) => {
      const { rows } = await app.pg.query(
        `SELECT * FROM cron_executions WHERE cron_id = $1 ORDER BY triggered_at DESC LIMIT 50`,
        [req.params.cronId],
      )
      return rows
    },
  )

  // Delete cron job
  app.delete<{ Params: { projectId: string; cronId: string } }>(
    '/projects/:projectId/cron/:cronId',
    async (req, reply) => {
      await app.pg.query(`DELETE FROM cron_jobs WHERE id = $1 AND tenant_id = $2`, [req.params.cronId, (req as any).tenantId])
      return reply.status(204).send()
    },
  )

  // =========================================================================
  // JOB QUEUES
  // =========================================================================

  // List queues
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/queues', async (req) => {
    const tenantId = (req as any).tenantId
    const { rows } = await app.pg.query(
      `SELECT q.*,
              (SELECT COUNT(*) FROM jobs WHERE queue_id = q.id AND status = 'pending') AS pending_count,
              (SELECT COUNT(*) FROM jobs WHERE queue_id = q.id AND status = 'processing') AS processing_count,
              (SELECT COUNT(*) FROM jobs WHERE queue_id = q.id AND status = 'failed') AS failed_count
         FROM job_queues q WHERE q.tenant_id = $1 AND q.project_id = $2`,
      [tenantId, req.params.projectId],
    )
    return rows
  })

  // Create queue
  app.post<{
    Params: { projectId: string }
    Body: { name: string; endpoint_url: string; max_retries?: number; concurrency?: number; timeout_seconds?: number }
  }>(
    '/projects/:projectId/queues',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'endpoint_url'],
          properties: {
            name:            { type: 'string', minLength: 1 },
            endpoint_url:    { type: 'string', format: 'uri' },
            max_retries:     { type: 'integer', minimum: 0, maximum: 10 },
            concurrency:     { type: 'integer', minimum: 1, maximum: 100 },
            timeout_seconds: { type: 'integer', minimum: 5, maximum: 900 },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { name, endpoint_url, max_retries = 3, concurrency = 5, timeout_seconds = 300 } = req.body
      const { rows } = await app.pg.query(
        `INSERT INTO job_queues (tenant_id, project_id, name, endpoint_url, max_retries, concurrency, timeout_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [tenantId, req.params.projectId, name, endpoint_url, max_retries, concurrency, timeout_seconds],
      )
      return reply.status(201).send(rows[0])
    },
  )

  // Enqueue a job
  app.post<{ Params: { projectId: string; queueId: string }; Body: { payload: any; priority?: number; delay_seconds?: number } }>(
    '/projects/:projectId/queues/:queueId/jobs',
    async (req, reply) => {
      const tenantId = (req as any).tenantId
      const { payload, priority = 0, delay_seconds = 0 } = req.body

      const { rows: queue } = await app.pg.query(
        `SELECT max_retries FROM job_queues WHERE id = $1 AND tenant_id = $2`,
        [req.params.queueId, tenantId],
      )
      if (!queue.length) return reply.status(404).send({ error: 'Queue not found' })

      const scheduledFor = delay_seconds > 0
        ? new Date(Date.now() + delay_seconds * 1000).toISOString()
        : new Date().toISOString()

      const { rows } = await app.pg.query(
        `INSERT INTO jobs (queue_id, tenant_id, payload, priority, max_retries, scheduled_for)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, status, priority, scheduled_for, created_at`,
        [req.params.queueId, tenantId, JSON.stringify(payload), priority, queue[0].max_retries, scheduledFor],
      )
      return reply.status(201).send(rows[0])
    },
  )

  // List jobs in queue (with status filter)
  app.get<{ Params: { projectId: string; queueId: string }; Querystring: { status?: string; limit?: number } }>(
    '/projects/:projectId/queues/:queueId/jobs',
    async (req) => {
      const { status, limit = 50 } = req.query
      const conditions = ['queue_id = $1']
      const params: any[] = [req.params.queueId]

      if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status) }

      const { rows } = await app.pg.query(
        `SELECT * FROM jobs WHERE ${conditions.join(' AND ')} ORDER BY priority DESC, created_at LIMIT $${params.length + 1}`,
        [...params, Math.min(limit, 100)],
      )
      return rows
    },
  )
}
