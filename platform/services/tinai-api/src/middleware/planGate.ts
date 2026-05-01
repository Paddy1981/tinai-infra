import { FastifyRequest, FastifyReply } from 'fastify'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlanLimits {
  max_workloads: number
  max_databases: number
  max_functions: number
  max_custom_domains: number
  storage_gb: number
  api_calls_month: number
}

interface CacheEntry {
  limits: PlanLimits
  plan_id: string
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Simple in-process TTL cache: tenant_id -> plan limits
// Avoids hitting the DB on every create request; refreshes every 60 seconds.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 60_000
const planCache = new Map<string, CacheEntry>()

function getCache(tenantId: string): CacheEntry | null {
  const entry = planCache.get(tenantId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    planCache.delete(tenantId)
    return null
  }
  return entry
}

function setCache(tenantId: string, plan_id: string, limits: PlanLimits): void {
  planCache.set(tenantId, {
    limits,
    plan_id,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
}

// ---------------------------------------------------------------------------
// Resource → count query map
// ---------------------------------------------------------------------------
const RESOURCE_QUERIES: Record<string, string> = {
  max_workloads:      `SELECT COUNT(*) AS cnt FROM workloads  WHERE tenant_id = $1`,
  max_databases:      `SELECT COUNT(*) AS cnt FROM app_databases ad JOIN apps a ON a.name = ad.app_name WHERE a.owner = $1`,
  max_functions:      `SELECT COUNT(*) AS cnt FROM workloads  WHERE tenant_id = $1 AND type = 'function'`,
  max_custom_domains: `SELECT COUNT(*) AS cnt FROM mail_domains WHERE tenant_id = $1`,
}

// The plan limit key for each resource string passed into requirePlan()
const RESOURCE_TO_LIMIT_KEY: Record<string, keyof PlanLimits> = {
  workloads:      'max_workloads',
  databases:      'max_databases',
  functions:      'max_functions',
  custom_domains: 'max_custom_domains',
}

// ---------------------------------------------------------------------------
// Exported helper — resolves plan limits for a tenant (cache-first).
// Accepts a pg pool directly so it can be called outside of a request context.
// ---------------------------------------------------------------------------
export async function getPlanLimits(
  pg: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  tenantId: string,
): Promise<{ plan_id: string; limits: PlanLimits }> {
  const cached = getCache(tenantId)
  if (cached) return { plan_id: cached.plan_id, limits: cached.limits }

  const planResult = await pg.query(
    `SELECT tp.plan_id, p.limits, tp.override_limits
     FROM   tenant_plans tp
     JOIN   plans p ON p.id = tp.plan_id
     WHERE  tp.tenant_id = $1
       AND  (tp.expires_at IS NULL OR tp.expires_at > NOW())`,
    [tenantId],
  ) as { rows: Array<{ plan_id: string; limits: PlanLimits; override_limits: PlanLimits | null }> }

  let plan_id: string
  let limits: PlanLimits

  if (planResult.rows.length) {
    plan_id = planResult.rows[0].plan_id
    limits = planResult.rows[0].override_limits
      ? { ...planResult.rows[0].limits, ...planResult.rows[0].override_limits }
      : planResult.rows[0].limits
  } else {
    const freeResult = await pg.query(`SELECT limits FROM plans WHERE id = 'free'`) as { rows: Array<{ limits: PlanLimits }> }
    plan_id = 'free'
    limits = freeResult.rows.length
      ? freeResult.rows[0].limits
      : { max_workloads: 3, max_databases: 1, max_functions: 5, max_custom_domains: 0, storage_gb: 1, api_calls_month: 10_000 }
  }

  setCache(tenantId, plan_id, limits)
  return { plan_id, limits }
}

// ---------------------------------------------------------------------------
// Factory — returns a Fastify preHandler for the given resource
// ---------------------------------------------------------------------------
export function requirePlan(resource: string) {
  const limitKey = RESOURCE_TO_LIMIT_KEY[resource]
  if (!limitKey) {
    throw new Error(`planGate: unknown resource "${resource}". Valid: workloads, databases, functions`)
  }

  const countQuery = RESOURCE_QUERIES[limitKey]

  return async function planGateHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) {
      // Auth middleware should have caught this already, but guard defensively.
      return reply.status(401).send({ error: 'unauthorized' })
    }

    // ------------------------------------------------------------------
    // 1. Resolve plan limits (cache-first)
    // ------------------------------------------------------------------
    let entry = getCache(tenantId)

    if (!entry) {
      // Query tenant_plans JOIN plans; fall back to 'free' if no row exists.
      const pg = (req.server as any).pg
      const planResult = await pg.query(
        `SELECT tp.plan_id,
                p.limits,
                tp.override_limits
         FROM   tenant_plans tp
         JOIN   plans p ON p.id = tp.plan_id
         WHERE  tp.tenant_id = $1
           AND  (tp.expires_at IS NULL OR tp.expires_at > NOW())`,
        [tenantId],
      ) as { rows: Array<{ plan_id: string; limits: PlanLimits; override_limits: PlanLimits | null }> }

      let plan_id: string
      let limits: PlanLimits

      if (planResult.rows.length) {
        plan_id = planResult.rows[0].plan_id
        // Merge per-tenant overrides on top of the plan defaults
        limits = planResult.rows[0].override_limits
          ? { ...planResult.rows[0].limits, ...planResult.rows[0].override_limits }
          : planResult.rows[0].limits
      } else {
        // Default: free plan (query the plans table for safety)
        const freeResult = await pg.query(
          `SELECT limits FROM plans WHERE id = 'free'`,
        ) as { rows: Array<{ limits: PlanLimits }> }
        plan_id = 'free'
        limits = freeResult.rows.length
          ? freeResult.rows[0].limits
          : {
              max_workloads: 3,
              max_databases: 1,
              max_functions: 5,
              max_custom_domains: 0,
              storage_gb: 1,
              api_calls_month: 10_000,
            }
      }

      setCache(tenantId, plan_id, limits)
      entry = { plan_id, limits, expiresAt: Date.now() + CACHE_TTL_MS }
    }

    const limit = entry.limits[limitKey]

    // ------------------------------------------------------------------
    // 2. -1 means unlimited (Enterprise)
    // ------------------------------------------------------------------
    if (limit === -1) return

    // ------------------------------------------------------------------
    // 3. Count current usage
    // ------------------------------------------------------------------
    const pg = (req.server as any).pg
    const countResult = await pg.query(countQuery, [tenantId]) as { rows: Array<{ cnt: string }> }
    const current = parseInt(countResult.rows[0]?.cnt ?? '0', 10)

    // ------------------------------------------------------------------
    // 4. Enforce
    // ------------------------------------------------------------------
    if (current >= limit) {
      return reply.status(402).send({
        error:       'plan_limit_exceeded',
        resource,
        limit,
        current,
        plan:        entry.plan_id,
        upgrade_url: 'https://app.tinai.cloud/billing',
      })
    }
  }
}
