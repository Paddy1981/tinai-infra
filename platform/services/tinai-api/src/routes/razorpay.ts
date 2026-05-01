import { FastifyInstance } from 'fastify'
import crypto from 'crypto'

// ---------------------------------------------------------------------------
// Razorpay Integration for Tinai Cloud
//
// Environment variables needed:
//   RAZORPAY_KEY_ID       - from Razorpay Dashboard → Settings → API Keys
//   RAZORPAY_KEY_SECRET   - secret key (never expose to frontend)
//   RAZORPAY_WEBHOOK_SECRET - from Razorpay Dashboard → Webhooks
//
// Flow:
//   1. Tenant clicks "Upgrade" on pricing page
//   2. Dashboard calls POST /api/v1/payments/order (creates Razorpay order)
//   3. Frontend opens Razorpay checkout with order_id
//   4. On payment success, Razorpay sends webhook to POST /api/v1/payments/webhook
//   5. We verify signature, activate the plan for the tenant
// ---------------------------------------------------------------------------

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID ?? ''
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? ''
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? ''
const RAZORPAY_API = 'https://api.razorpay.com/v1'

function razorpayAuth(): string {
  return 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')
}

interface CreateOrderBody {
  plan_id: string
  billing_cycle: 'monthly' | 'yearly'
}

interface WebhookBody {
  event: string
  payload: {
    payment?: { entity: { id: string; order_id: string; amount: number; status: string } }
    subscription?: { entity: { id: string; plan_id: string; status: string } }
  }
}

export async function razorpayRoutes(app: FastifyInstance) {

  // GET /payments/config — returns public key for frontend checkout
  app.get('/payments/config', async () => {
    return {
      key_id: RAZORPAY_KEY_ID,
      currency: 'INR',
      company_name: 'Tinai Cloud',
      description: 'Tinai Cloud Platform Subscription',
      configured: !!RAZORPAY_KEY_ID,
    }
  })

  // POST /payments/order — create a Razorpay order for plan upgrade
  app.post<{ Body: CreateOrderBody }>('/payments/order', {
    schema: {
      body: {
        type: 'object',
        required: ['plan_id', 'billing_cycle'],
        properties: {
          plan_id: { type: 'string' },
          billing_cycle: { type: 'string', enum: ['monthly', 'yearly'] },
        },
      },
    },
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const userId = (req as any).userId as string
    const { plan_id, billing_cycle } = req.body

    if (!RAZORPAY_KEY_ID) {
      return reply.status(503).send({
        error: 'Payment gateway not configured yet. Contact admin@tinai.cloud for manual plan upgrades.',
        manual_upgrade: true,
      })
    }

    // Get plan pricing
    const { rows: [plan] } = await app.pg.query(
      'SELECT * FROM plans WHERE id = $1', [plan_id],
    )
    if (!plan) return reply.status(404).send({ error: 'plan not found' })

    const amount_paise = billing_cycle === 'yearly'
      ? plan.price_yearly_paise
      : plan.price_monthly_paise

    if (!amount_paise || amount_paise <= 0) {
      return reply.status(400).send({ error: 'this plan does not require payment' })
    }

    // Get user email for receipt
    const { rows: [user] } = await app.pg.query(
      'SELECT email FROM users WHERE id = $1', [userId],
    )

    // Create Razorpay order
    const orderRes = await fetch(`${RAZORPAY_API}/orders`, {
      method: 'POST',
      headers: {
        Authorization: razorpayAuth(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amount_paise,
        currency: 'INR',
        receipt: `tinai_${tenantId}_${Date.now()}`,
        notes: {
          tenant_id: tenantId,
          user_id: userId,
          plan_id: plan_id,
          billing_cycle: billing_cycle,
        },
      }),
    })

    if (!orderRes.ok) {
      const err = await orderRes.json().catch(() => ({}))
      return reply.status(502).send({ error: 'failed to create payment order', detail: err })
    }

    const order = await orderRes.json() as { id: string; amount: number; currency: string }

    // Store order in DB for tracking
    await app.pg.query(
      `INSERT INTO payment_orders (order_id, tenant_id, user_id, plan_id, billing_cycle, amount_paise, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'created')
       ON CONFLICT (order_id) DO NOTHING`,
      [order.id, tenantId, userId, plan_id, billing_cycle, amount_paise],
    )

    return {
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: RAZORPAY_KEY_ID,
      prefill: {
        email: user?.email ?? '',
      },
      notes: {
        plan: plan.name,
        cycle: billing_cycle,
      },
    }
  })

  // POST /payments/verify — verify payment after checkout (called by frontend)
  app.post<{ Body: { order_id: string; payment_id: string; signature: string } }>(
    '/payments/verify',
    async (req, reply) => {
      const { order_id, payment_id, signature } = req.body
      const tenantId = (req as any).tenantId as string

      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(`${order_id}|${payment_id}`)
        .digest('hex')

      if (signature !== expectedSignature) {
        return reply.status(400).send({ error: 'invalid payment signature' })
      }

      // Get order details
      const { rows: [order] } = await app.pg.query(
        'SELECT * FROM payment_orders WHERE order_id = $1 AND tenant_id = $2',
        [order_id, tenantId],
      )
      if (!order) return reply.status(404).send({ error: 'order not found' })

      // Activate the plan
      await app.pg.query(
        `INSERT INTO tenant_plans (tenant_id, plan_id)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO UPDATE SET plan_id = $2, started_at = NOW()`,
        [tenantId, order.plan_id],
      )

      // Update order status
      await app.pg.query(
        `UPDATE payment_orders SET status = 'paid', payment_id = $1, paid_at = NOW()
         WHERE order_id = $2`,
        [payment_id, order_id],
      )

      return { success: true, plan: order.plan_id }
    },
  )

  // POST /payments/webhook — Razorpay webhook handler (no auth, signature verified)
  app.post<{ Body: WebhookBody }>('/payments/webhook', async (req, reply) => {
    // Verify webhook signature
    const signature = req.headers['x-razorpay-signature'] as string
    if (!signature || !RAZORPAY_WEBHOOK_SECRET) {
      return reply.status(400).send({ error: 'missing signature' })
    }

    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex')

    if (signature !== expectedSignature) {
      return reply.status(400).send({ error: 'invalid webhook signature' })
    }

    const { event, payload } = req.body

    if (event === 'payment.captured' && payload.payment) {
      const payment = payload.payment.entity
      await app.pg.query(
        `UPDATE payment_orders SET status = 'captured', payment_id = $1, paid_at = NOW()
         WHERE order_id = $2`,
        [payment.id, payment.order_id],
      )
    }

    return { ok: true }
  })
}
