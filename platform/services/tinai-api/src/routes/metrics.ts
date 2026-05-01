// Registered in server.ts: app.register(metricsRoutes, { prefix: '/api/v1' })

import { FastifyInstance } from 'fastify'

type Period = '1h' | '6h' | '24h' | '7d'

const PERIOD_MAP: Record<Period, string> = {
  '1h':  '1 hour',
  '6h':  '6 hours',
  '24h': '24 hours',
  '7d':  '7 days',
}

export async function metricsRoutes(app: FastifyInstance) {
  // GET /metrics/summary — scoped to the caller's own apps
  // must come before /metrics/:appName to avoid param capture
  app.get('/metrics/summary', async (req) => {
    const tenantId = (req as any).tenantId as string

    const { rows } = await app.pg.query(`
      SELECT
        u.app_name,
        ROUND(AVG(u.cpu_cores)::numeric, 6)                          AS avg_cpu,
        ROUND(MAX(u.cpu_cores)::numeric, 6)                          AS max_cpu,
        ROUND((AVG(u.memory_bytes) / 1048576.0)::numeric, 2)         AS avg_memory_mb,
        ROUND((MAX(u.memory_bytes) / 1048576.0)::numeric, 2)         AS max_memory_mb,
        ROUND(
          (SUM(u.cpu_cores * 5.0 / 60) * 50 + SUM(u.memory_bytes / 1073741824.0 * 5.0 / 60) * 25)::numeric,
          0
        )                                                             AS total_cost_paise
      FROM usage_snapshots u
      JOIN apps a ON a.name = u.app_name
      WHERE u.snapshot_at > NOW() - INTERVAL '24 hours'
        AND a.owner = $1
      GROUP BY u.app_name
      ORDER BY u.app_name
    `, [tenantId])

    return {
      apps: rows.map(r => ({
        app_name:        r.app_name,
        avg_cpu:         parseFloat(r.avg_cpu),
        max_cpu:         parseFloat(r.max_cpu),
        avg_memory_mb:   parseFloat(r.avg_memory_mb),
        max_memory_mb:   parseFloat(r.max_memory_mb),
        total_cost_paise: parseInt(r.total_cost_paise, 10),
      })),
    }
  })

  // GET /metrics/:appName?period=1h|6h|24h|7d — enforce ownership
  app.get<{
    Params: { appName: string }
    Querystring: { period?: string }
  }>('/metrics/:appName', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { appName } = req.params
    const period = (req.query.period ?? '24h') as Period

    if (!PERIOD_MAP[period]) {
      return reply.status(400).send({ error: 'period must be one of: 1h, 6h, 24h, 7d' })
    }

    // Verify caller owns this app before returning its metrics
    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [appName]
    )
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const interval = PERIOD_MAP[period]

    const { rows } = await app.pg.query(
      `SELECT snapshot_at, cpu_cores, memory_bytes
       FROM usage_snapshots
       WHERE app_name = $1
         AND snapshot_at > NOW() - INTERVAL '${interval}'
       ORDER BY snapshot_at ASC`,
      [appName],
    )

    return {
      app_name: appName,
      period,
      points: rows.map(r => ({
        timestamp:    r.snapshot_at,
        cpu_cores:    parseFloat(r.cpu_cores),
        memory_bytes: parseInt(r.memory_bytes, 10),
        memory_mb:    Math.round(parseInt(r.memory_bytes, 10) / 1048576),
      })),
    }
  })
}
