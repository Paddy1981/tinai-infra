import { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Razorpay order creation helper (conditional — only if RAZORPAY_KEY_ID is set)
// ---------------------------------------------------------------------------
async function createRazorpayOrder(amountInr: number): Promise<{
  id: string
  currency: string
  amount: number
} | null> {
  const keyId     = process.env.RAZORPAY_KEY_ID
  const keySecret = process.env.RAZORPAY_KEY_SECRET

  if (!keyId || !keySecret) return null

  const amountPaise = amountInr * 100 // Razorpay uses smallest currency unit
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64')

  try {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${credentials}`,
      },
      body: JSON.stringify({
        amount:   amountPaise,
        currency: 'INR',
        receipt:  `tinai-upgrade-${Date.now()}`,
      }),
    })

    if (!res.ok) return null
    const data = (await res.json()) as { id: string; currency: string; amount: number }
    return data
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export async function plansRoutes(app: FastifyInstance) {

  // -------------------------------------------------------------------------
  // GET /plans — list all plans with their feature limits
  // -------------------------------------------------------------------------
  app.get('/plans', async (_req, _reply) => {
    const { rows } = await app.pg.query(
      `SELECT id, name, price_inr, price_monthly_paise, price_yearly_paise, description, features, limits, sort_order
       FROM plans WHERE is_active = true ORDER BY sort_order ASC`,
    )
    return rows
  })

  // -------------------------------------------------------------------------
  // GET /plans/current — current tenant's plan + usage stats
  // -------------------------------------------------------------------------
  app.get('/plans/current', async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    // Resolve plan row — default to free if no assignment
    const { rows: planRows } = await app.pg.query<{
      plan_id: string
      name: string
      price_inr: number
      limits: Record<string, number>
      override_limits: Record<string, number> | null
      started_at: string
      expires_at: string | null
    }>(
      `SELECT tp.plan_id,
              p.name,
              p.price_inr,
              p.limits,
              tp.override_limits,
              tp.started_at,
              tp.expires_at
       FROM   tenant_plans tp
       JOIN   plans p ON p.id = tp.plan_id
       WHERE  tp.tenant_id = $1
         AND  (tp.expires_at IS NULL OR tp.expires_at > NOW())`,
      [tenantId],
    )

    let planId: string
    let planName: string
    let priceInr: number
    let limits: Record<string, number>
    let startedAt: string | null = null
    let expiresAt: string | null = null

    if (planRows.length) {
      const row = planRows[0]
      planId   = row.plan_id
      planName = row.name
      priceInr = row.price_inr
      limits   = row.override_limits
        ? { ...row.limits, ...row.override_limits }
        : row.limits
      startedAt = row.started_at
      expiresAt = row.expires_at
    } else {
      // Fall back to the free plan definition
      const { rows: free } = await app.pg.query<{
        name: string; price_inr: number; limits: Record<string, number>
      }>(`SELECT name, price_inr, limits FROM plans WHERE id = 'free'`)
      planId   = 'free'
      planName = free[0]?.name ?? 'Free'
      priceInr = free[0]?.price_inr ?? 0
      limits   = free[0]?.limits ?? {
        max_workloads: 3, max_databases: 1, max_functions: 5,
        storage_gb: 1, api_calls_month: 10_000,
      }
    }

    // Collect usage in parallel
    const [workloadsRes, databasesRes, functionsRes] = await Promise.all([
      app.pg.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM workloads WHERE tenant_id = $1`,
        [tenantId],
      ),
      app.pg.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt
         FROM   app_databases ad
         JOIN   apps a ON a.name = ad.app_name
         WHERE  a.owner = $1`,
        [tenantId],
      ),
      app.pg.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM workloads WHERE tenant_id = $1 AND type = 'function'`,
        [tenantId],
      ),
    ])

    const usage = {
      workloads:  parseInt(workloadsRes.rows[0]?.cnt  ?? '0', 10),
      databases:  parseInt(databasesRes.rows[0]?.cnt  ?? '0', 10),
      functions:  parseInt(functionsRes.rows[0]?.cnt  ?? '0', 10),
    }

    return reply.send({
      plan: {
        id:        planId,
        name:      planName,
        price_inr: priceInr,
        limits,
        started_at: startedAt,
        expires_at: expiresAt,
      },
      usage,
    })
  })

  // -------------------------------------------------------------------------
  // POST /plans/upgrade — upgrade or switch plan
  // Body: { plan_id: string }
  // -------------------------------------------------------------------------
  app.post<{ Body: { plan_id: string } }>(
    '/plans/upgrade',
    {
      schema: {
        body: {
          type: 'object',
          required: ['plan_id'],
          properties: {
            plan_id: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { plan_id } = req.body

      // Validate the requested plan exists
      const { rows: planRows } = await app.pg.query<{
        id: string; name: string; price_inr: number
      }>(
        `SELECT id, name, price_inr FROM plans WHERE id = $1`,
        [plan_id],
      )
      if (!planRows.length) {
        return reply.status(400).send({ error: 'invalid plan_id' })
      }
      const plan = planRows[0]

      // Upsert tenant_plans
      await app.pg.query(
        `INSERT INTO tenant_plans (tenant_id, plan_id, started_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (tenant_id) DO UPDATE
           SET plan_id    = EXCLUDED.plan_id,
               started_at = NOW(),
               expires_at = NULL`,
        [tenantId, plan_id],
      )

      // If upgrading to a paid plan, create a Razorpay order
      let razorpay_order: object | null = null
      if (plan.price_inr > 0) {
        razorpay_order = await createRazorpayOrder(plan.price_inr)
      }

      return reply.status(200).send({
        plan_id,
        plan_name:     plan.name,
        price_inr:     plan.price_inr,
        razorpay_order,
        upgrade_url:   razorpay_order ? null : null,
      })
    },
  )
}
