import { FastifyInstance } from 'fastify'

export async function gatewayRoutes(app: FastifyInstance) {
  // GET /gateway/usage — monthly AI usage for the authenticated tenant.
  // Queries gateway_usage and gateway_quotas tables (same DB as the API).
  app.get('/gateway/usage', async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    // Quota / preferred model
    const quotaRow = await app.pg
      .query(
        `SELECT monthly_limit_paise, preferred_model
         FROM gateway_quotas
         WHERE tenant_id = $1`,
        [tenantId],
      )
      .then((r) => r.rows[0] ?? null)
      .catch(() => null)

    const quotaPaise: number = quotaRow?.monthly_limit_paise ?? 100_000
    const preferredModel: string | undefined = quotaRow?.preferred_model ?? undefined

    // Month totals
    const totalsRow = await app.pg
      .query(
        `SELECT
           COALESCE(SUM(cost_paise), 0)::bigint                                AS month_total_paise,
           COUNT(*)::int                                                        AS total_requests,
           COALESCE(SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END), 0)::int        AS cache_hits
         FROM gateway_usage
         WHERE tenant_id = $1
           AND created_at >= date_trunc('month', NOW())`,
        [tenantId],
      )
      .then((r) => r.rows[0])
      .catch(() => ({ month_total_paise: 0, total_requests: 0, cache_hits: 0 }))

    const monthTotalPaise = Number(totalsRow.month_total_paise)
    const totalRequests = Number(totalsRow.total_requests)
    const cacheHits = Number(totalsRow.cache_hits)
    const nonCacheRequests = totalRequests - cacheHits
    const cacheHitRate = totalRequests > 0 ? cacheHits / totalRequests : 0
    const avgCostPaise = nonCacheRequests > 0 ? monthTotalPaise / nonCacheRequests : 0
    const cacheSavedPaise = Math.round(avgCostPaise * cacheHits)

    // Per-model breakdown
    const modelRows = await app.pg
      .query(
        `SELECT
           model_id                                                             AS model,
           COUNT(*)::int                                                        AS requests,
           COALESCE(SUM(input_tokens), 0)::int                                 AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::int                                AS output_tokens,
           COALESCE(SUM(cost_paise), 0)::bigint                                AS cost_paise,
           COALESCE(SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END), 0)::int        AS cache_hits
         FROM gateway_usage
         WHERE tenant_id = $1
           AND created_at >= date_trunc('month', NOW())
         GROUP BY model_id
         ORDER BY cost_paise DESC`,
        [tenantId],
      )
      .then((r) => r.rows.map((row) => ({ ...row, cost_paise: Number(row.cost_paise) })))
      .catch(() => [])

    // Daily spend — last 30 days
    const dailyRows = await app.pg
      .query(
        `SELECT
           TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
           model_id                                               AS model,
           COALESCE(SUM(cost_paise), 0)::bigint                  AS cost_paise
         FROM gateway_usage
         WHERE tenant_id = $1
           AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY date, model_id
         ORDER BY date DESC, cost_paise DESC`,
        [tenantId],
      )
      .then((r) => r.rows.map((row) => ({ ...row, cost_paise: Number(row.cost_paise) })))
      .catch(() => [])

    return reply.send({
      month_total_paise: monthTotalPaise,
      quota_paise: quotaPaise,
      cache_saved_paise: cacheSavedPaise,
      cache_hit_rate: cacheHitRate,
      models: modelRows,
      daily: dailyRows,
      ...(preferredModel ? { preferred_model: preferredModel } : {}),
    })
  })
}
