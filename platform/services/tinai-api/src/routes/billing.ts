import { FastifyInstance } from 'fastify'
import * as https from 'https'
import * as crypto from 'crypto'

// Pricing in paise (1 ₹ = 100 paise)
const CPU_PAISE_PER_CORE_HOUR = 50   // ₹0.50 per CPU-core-hour
const MEM_PAISE_PER_GB_HOUR = 25     // ₹0.25 per GB-hour
const GST_RATE = 0.18

export async function billingRoutes(app: FastifyInstance) {
  // Current month usage — scoped to the caller's own apps
  app.get('/billing/usage/current', async (req) => {
    const tenantId = (req as any).tenantId as string
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    const { rows } = await app.pg.query(`
      SELECT
        u.app_name,
        ROUND(SUM(u.cpu_cores * 5.0 / 60), 4)            AS cpu_core_hours,
        ROUND(SUM(u.memory_bytes / 1073741824.0 * 5.0 / 60), 4) AS memory_gb_hours
      FROM usage_snapshots u
      JOIN apps a ON a.name = u.app_name
      WHERE u.snapshot_at >= $1
        AND a.owner = $2
      GROUP BY u.app_name
      ORDER BY u.app_name
    `, [monthStart.toISOString(), tenantId])

    return rows.map(r => {
      const cpu = parseFloat(r.cpu_core_hours)
      const mem = parseFloat(r.memory_gb_hours)
      const subtotal = Math.round(cpu * CPU_PAISE_PER_CORE_HOUR + mem * MEM_PAISE_PER_GB_HOUR)
      return {
        app_name: r.app_name,
        cpu_core_hours: cpu,
        memory_gb_hours: mem,
        estimated_paise: subtotal,
        estimated_inr: (subtotal / 100).toFixed(2),
      }
    })
  })

  // List invoices — scoped to the caller's tenant
  app.get('/billing/invoices', async (req) => {
    const tenantId = (req as any).tenantId as string
    const { rows } = await app.pg.query(
      'SELECT id, month, subtotal_paise, gst_paise, total_paise, status, created_at FROM invoices WHERE tenant = $1 ORDER BY month DESC',
      [tenantId],
    )
    return rows.map((r: any) => {
      const monthDate = new Date(r.month)
      const periodStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
      const periodEnd   = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0)
      return {
        id:             r.id,
        period_start:   periodStart.toISOString().slice(0, 10),
        period_end:     periodEnd.toISOString().slice(0, 10),
        subtotal_paise: r.subtotal_paise,
        tax_paise:      r.gst_paise,
        total_paise:    r.total_paise,
        status:         r.status,
        pdf_url:        null,
        created_at:     r.created_at,
      }
    })
  })

  // Get one invoice with line items — enforce ownership
  app.get<{ Params: { id: string } }>('/billing/invoices/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { rows: [invoice] } = await app.pg.query(
      'SELECT * FROM invoices WHERE id = $1',
      [req.params.id],
    )
    if (!invoice) return reply.status(404).send({ error: 'not found' })
    if (invoice.tenant !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows: lineItems } = await app.pg.query(
      'SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY id', [req.params.id]
    )
    return { ...invoice, line_items: lineItems }
  })

  // Generate/refresh invoice for current month — scoped to the caller's tenant
  app.post('/billing/invoices/generate', async (req) => {
    const tenantId = (req as any).tenantId as string
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    const monthKey = monthStart.toISOString().slice(0, 10)

    const { rows: usageRows } = await app.pg.query(`
      SELECT
        u.app_name,
        ROUND(SUM(u.cpu_cores * 5.0 / 60), 4)            AS cpu_core_hours,
        ROUND(SUM(u.memory_bytes / 1073741824.0 * 5.0 / 60), 4) AS memory_gb_hours
      FROM usage_snapshots u
      JOIN apps a ON a.name = u.app_name
      WHERE u.snapshot_at >= $1
        AND a.owner = $2
      GROUP BY u.app_name
    `, [monthStart.toISOString(), tenantId])

    const lineItems: { description: string; quantity: number; unit_price: number; amount: number }[] = []
    let subtotal = 0

    for (const row of usageRows) {
      const cpuHours = parseFloat(row.cpu_core_hours)
      const memHours = parseFloat(row.memory_gb_hours)
      if (cpuHours > 0) {
        const amount = Math.round(cpuHours * CPU_PAISE_PER_CORE_HOUR)
        lineItems.push({ description: `${row.app_name} — CPU (${cpuHours.toFixed(4)} core-hrs)`, quantity: cpuHours, unit_price: CPU_PAISE_PER_CORE_HOUR, amount })
        subtotal += amount
      }
      if (memHours > 0) {
        const amount = Math.round(memHours * MEM_PAISE_PER_GB_HOUR)
        lineItems.push({ description: `${row.app_name} — Memory (${memHours.toFixed(4)} GB-hrs)`, quantity: memHours, unit_price: MEM_PAISE_PER_GB_HOUR, amount })
        subtotal += amount
      }
    }

    const gst = Math.round(subtotal * GST_RATE)
    const total = subtotal + gst

    // Upsert invoice scoped to the caller's tenant
    const { rows: [existing] } = await app.pg.query(
      `SELECT id FROM invoices WHERE month = $1 AND tenant = $2`, [monthKey, tenantId]
    )

    let invoiceId: string
    if (existing) {
      await app.pg.query(
        `UPDATE invoices SET subtotal_paise=$1, gst_paise=$2, total_paise=$3 WHERE id=$4`,
        [subtotal, gst, total, existing.id]
      )
      await app.pg.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [existing.id])
      invoiceId = existing.id
    } else {
      const { rows: [inv] } = await app.pg.query(
        `INSERT INTO invoices (tenant, month, subtotal_paise, gst_paise, total_paise) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenantId, monthKey, subtotal, gst, total]
      )
      invoiceId = inv.id
    }

    for (const li of lineItems) {
      await app.pg.query(
        `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price_paise, amount_paise) VALUES ($1,$2,$3,$4,$5)`,
        [invoiceId, li.description, li.quantity, li.unit_price, li.amount]
      )
    }

    return { invoice_id: invoiceId, subtotal_paise: subtotal, gst_paise: gst, total_paise: total, line_items: lineItems.length }
  })

  // ── Active (per-second) billing ───────────────────────────────────────────

  // GET /billing/active-usage — current-month totals, scoped to caller's own apps
  app.get('/billing/active-usage', async (req) => {
    const tenantId = (req as any).tenantId as string
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    // Month-to-date aggregates — only for apps owned by the caller
    const { rows: monthRows } = await app.pg.query(`
      SELECT
        c.app_name,
        SUM(c.cpu_seconds)                                        AS total_cpu_seconds,
        ROUND(SUM(c.cpu_seconds) * 0.14)::BIGINT                 AS cpu_cost_paise,
        SUM(c.memory_byte_secs) / (1024.0 * 1024 * 1024)        AS total_gb_seconds,
        ROUND(SUM(c.memory_byte_secs) / (1024.0 * 1024 * 1024) * 0.007)::BIGINT
                                                               AS memory_cost_paise
      FROM cpu_seconds_log c
      JOIN apps a ON a.name = c.app_name
      WHERE c.window_start >= $1
        AND a.owner = $2
      GROUP BY c.app_name
      ORDER BY c.app_name
    `, [monthStart.toISOString(), tenantId])

    // Real-time snapshot: last 10 windows (≈100s) per app — only caller's apps
    const { rows: realtimeRows } = await app.pg.query(`
      SELECT
        c.app_name,
        SUM(c.cpu_seconds)                                        AS recent_cpu_seconds,
        ROUND(SUM(c.cpu_seconds) * 0.14)::BIGINT                 AS recent_cpu_cost_paise,
        SUM(c.memory_byte_secs) / (1024.0 * 1024 * 1024)        AS recent_gb_seconds
      FROM (
        SELECT csl.*, ROW_NUMBER() OVER (PARTITION BY csl.app_name ORDER BY csl.window_start DESC) AS rn
        FROM cpu_seconds_log csl
        JOIN apps a ON a.name = csl.app_name
        WHERE csl.window_start >= NOW() - INTERVAL '110 seconds'
          AND a.owner = $1
      ) c
      WHERE c.rn <= 10
      GROUP BY c.app_name
    `, [tenantId])

    const realtimeByApp = Object.fromEntries(
      realtimeRows.map(r => [r.app_name, r])
    )

    return monthRows.map(r => {
      const cpuSecs = parseFloat(r.total_cpu_seconds ?? '0')
      const gbSecs  = parseFloat(r.total_gb_seconds  ?? '0')
      const cpuCost   = Number(r.cpu_cost_paise   ?? 0)
      const memCost   = Number(r.memory_cost_paise ?? 0)
      const totalCost = cpuCost + memCost
      const rt = realtimeByApp[r.app_name] ?? {}
      return {
        app_name:             r.app_name,
        total_cpu_seconds:    cpuSecs,
        cpu_cost_paise:       cpuCost,
        total_gb_seconds:     gbSecs,
        memory_cost_paise:    memCost,
        total_cost_paise:     totalCost,
        total_cost_inr:       (totalCost / 100).toFixed(4),
        current_hour_snapshot: {
          cpu_seconds:      parseFloat(rt.recent_cpu_seconds ?? '0'),
          cpu_cost_paise:   Number(rt.recent_cpu_cost_paise  ?? 0),
          gb_seconds:       parseFloat(rt.recent_gb_seconds  ?? '0'),
        },
      }
    })
  })

  // GET /billing/active-usage/:app — 24h time-series for a specific app — enforce ownership
  app.get<{ Params: { app: string } }>('/billing/active-usage/:app', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { app: appName } = req.params

    const { rows: appCheck } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [appName]
    )
    if (!appCheck.length) return reply.status(404).send({ error: 'app not found' })
    if (appCheck[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(`
      SELECT
        window_start,
        window_end,
        cpu_seconds,
        memory_byte_secs,
        ROUND(cpu_seconds * 0.14)::BIGINT                              AS cpu_cost_paise,
        ROUND(memory_byte_secs / (1024.0 * 1024 * 1024) * 0.007)::BIGINT AS memory_cost_paise
      FROM cpu_seconds_log
      WHERE app_name = $1
        AND window_start >= NOW() - INTERVAL '24 hours'
      ORDER BY window_start ASC
    `, [appName])

    return {
      app_name: appName,
      rate_card: {
        cpu_paise_per_second:   0.14,
        cpu_inr_per_hour:       5.04,
        mem_paise_per_gb_second: 0.007,
        mem_inr_per_gb_hour:    0.025,
      },
      windows: rows.map(r => ({
        window_start:      r.window_start,
        window_end:        r.window_end,
        cpu_seconds:       parseFloat(r.cpu_seconds),
        memory_byte_secs:  Number(r.memory_byte_secs),
        cpu_cost_paise:    Number(r.cpu_cost_paise),
        memory_cost_paise: Number(r.memory_cost_paise),
      })),
    }
  })

  // ── Razorpay: create payment order — enforce invoice ownership ─────────────
  app.post<{ Body: { invoice_id: string } }>('/billing/payment-orders', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { invoice_id } = req.body
    if (!invoice_id) return reply.status(400).send({ error: 'invoice_id required' })

    const { rows: [invoice] } = await app.pg.query(
      'SELECT * FROM invoices WHERE id = $1', [invoice_id]
    )
    if (!invoice) return reply.status(404).send({ error: 'invoice not found' })
    if (invoice.tenant !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const keyId     = process.env.RAZORPAY_KEY_ID     ?? ''
    const keySecret = process.env.RAZORPAY_KEY_SECRET  ?? ''
    if (!keyId || !keySecret) return reply.status(500).send({ error: 'Razorpay credentials not configured' })

    // Call Razorpay Orders API using built-in https
    const orderPayload = JSON.stringify({
      amount:   invoice.total_paise,
      currency: 'INR',
      receipt:  `inv_${invoice_id}`,
    })

    const rzOrder = await new Promise<{ id: string; amount: number; currency: string }>((resolve, reject) => {
      const req2 = https.request(
        {
          hostname: 'api.razorpay.com',
          path:     '/v1/orders',
          method:   'POST',
          headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(orderPayload),
            'Authorization':  'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
          },
        },
        (res) => {
          let data = ''
          res.on('data', chunk => { data += chunk })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data)
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`Razorpay error ${res.statusCode}: ${data}`))
              } else {
                resolve(parsed)
              }
            } catch (e) {
              reject(e)
            }
          })
        }
      )
      req2.on('error', reject)
      req2.write(orderPayload)
      req2.end()
    })

    // Persist the Razorpay order id on the invoice
    await app.pg.query(
      `UPDATE invoices SET razorpay_order_id = $1, payment_status = 'pending' WHERE id = $2`,
      [rzOrder.id, invoice_id]
    )

    return { order_id: rzOrder.id, amount: rzOrder.amount, currency: rzOrder.currency, key_id: keyId }
  })

  // ── Razorpay: payment status — enforce invoice ownership ──────────────────
  app.get<{ Params: { invoice_id: string } }>('/billing/payment-status/:invoice_id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { rows: [invoice] } = await app.pg.query(
      `SELECT id, tenant, month, subtotal_paise, gst_paise, total_paise, status,
              razorpay_order_id, razorpay_payment_id, payment_status
       FROM invoices WHERE id = $1`,
      [req.params.invoice_id]
    )
    if (!invoice) return reply.status(404).send({ error: 'invoice not found' })
    if (invoice.tenant !== tenantId) return reply.status(403).send({ error: 'Forbidden' })
    return invoice
  })

  // ── Razorpay: webhook — public endpoint, verified by HMAC signature ────────
  app.post('/billing/webhooks/razorpay', {
    config: { rawBody: true },   // requires fastify-raw-body or equivalent
  }, async (req, reply) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET
    if (!webhookSecret) {
      // FIX: was `request.log.error(...)` — `request` is undefined here; must use `req`
      req.log.error('RAZORPAY_WEBHOOK_SECRET not configured — rejecting webhook')
      return reply.status(500).send({ error: 'webhook secret not configured' })
    }
    const signature     = (req.headers['x-razorpay-signature'] as string) ?? ''

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update((req as any).rawBody ?? JSON.stringify(req.body))
      .digest('hex')

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      app.log.warn('Razorpay webhook: invalid signature')
      return reply.status(400).send({ error: 'invalid signature' })
    }

    const payload = req.body as any
    app.log.info({ event: payload?.event }, 'razorpay webhook received')

    if (payload?.event === 'payment.captured') {
      const payment   = payload.payload?.payment?.entity
      const orderId   = payment?.order_id
      const paymentId = payment?.id
      if (orderId) {
        await app.pg.query(
          `UPDATE invoices
           SET status = 'paid', payment_status = 'captured',
               razorpay_payment_id = $1
           WHERE razorpay_order_id = $2`,
          [paymentId ?? null, orderId]
        )
      }
    } else if (payload?.event === 'payment.failed') {
      const payment = payload.payload?.payment?.entity
      const orderId = payment?.order_id
      if (orderId) {
        await app.pg.query(
          `UPDATE invoices SET payment_status = 'failed' WHERE razorpay_order_id = $1`,
          [orderId]
        )
      }
    }

    return reply.status(200).send({ ok: true })
  })

  // ── GET /billing/overview ─────────────────────────────────────────────────
  app.get('/billing/overview', async (req) => {
    const tenantId = (req as any).tenantId as string

    const now = new Date()

    // Current month boundaries
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const currentMonthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1)

    // Last month boundaries
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const lastMonthEnd   = currentMonthStart

    const formatPeriod = (start: Date, end: Date): string =>
      `${start.toISOString().slice(0, 7)}`

    // Helper: sum cpu_seconds_log cost for a tenant over a time window
    const sumCost = async (from: Date, to: Date): Promise<number> => {
      const { rows } = await app.pg.query(`
        SELECT
          COALESCE(
            ROUND(SUM(c.cpu_seconds) * 0.14)::BIGINT
            + ROUND(SUM(c.memory_byte_secs) / (1024.0 * 1024 * 1024) * 0.007)::BIGINT,
            0
          ) AS total_paise
        FROM cpu_seconds_log c
        JOIN apps a ON a.name = c.app_name
        WHERE c.window_start >= $1
          AND c.window_start <  $2
          AND a.owner = $3
      `, [from.toISOString(), to.toISOString(), tenantId])
      return Number(rows[0]?.total_paise ?? 0)
    }

    // Usage by app_name for current month (used to build usage_by_product)
    const { rows: usageRows } = await app.pg.query(`
      SELECT
        c.app_name,
        ROUND(SUM(c.cpu_seconds) * 0.14)::BIGINT
          + ROUND(SUM(c.memory_byte_secs) / (1024.0 * 1024 * 1024) * 0.007)::BIGINT
          AS app_paise
      FROM cpu_seconds_log c
      JOIN apps a ON a.name = c.app_name
      WHERE c.window_start >= $1
        AND c.window_start <  $2
        AND a.owner = $3
      GROUP BY c.app_name
      ORDER BY app_paise DESC
    `, [currentMonthStart.toISOString(), currentMonthEnd.toISOString(), tenantId])

    const [currentTotal, lastTotal] = await Promise.all([
      sumCost(currentMonthStart, currentMonthEnd),
      sumCost(lastMonthStart, lastMonthEnd),
    ])

    const usageByProduct = usageRows.map(r => ({
      product:    r.app_name as string,
      cost_paise: Number(r.app_paise ?? 0),
      unit_label: '',
    }))

    // Next invoice date: 1st of next month
    const nextInvoice = new Date(now.getFullYear(), now.getMonth() + 1, 1)

    return {
      current_month_paise:  currentTotal,
      last_month_paise:     lastTotal,
      credit_balance_paise: 0,
      next_invoice_date:    nextInvoice.toISOString().slice(0, 10),
      usage_by_product:     usageByProduct,
    }
  })

  // ── GET /billing/payment-methods ──────────────────────────────────────────
  // Stub: no card/Stripe storage yet — return empty array
  app.get('/billing/payment-methods', async (_req) => {
    return [] as Array<{
      id: string
      brand: string
      last4: string
      exp_month: number
      exp_year: number
      is_default: boolean
    }>
  })

  // ── POST /billing/checkout-session ────────────────────────────────────────
  // Creates a Razorpay order and returns the params needed to open Razorpay.js
  // checkout on the client side. If Razorpay keys are absent, returns a stub.
  app.post<{ Body: { invoice_id?: string } }>('/billing/checkout-session', async (req, reply) => {
    const tenantId  = (req as any).tenantId as string
    const invoiceId = req.body?.invoice_id

    const keyId     = process.env.RAZORPAY_KEY_ID     ?? ''
    const keySecret = process.env.RAZORPAY_KEY_SECRET  ?? ''

    // Determine amount: from invoice if provided, else current-month total
    let amountPaise = 0
    let receiptRef  = `checkout_${Date.now()}`

    if (invoiceId) {
      const { rows: [invoice] } = await app.pg.query(
        'SELECT * FROM invoices WHERE id = $1', [invoiceId]
      )
      if (!invoice) return reply.status(404).send({ error: 'invoice not found' })
      if (invoice.tenant !== tenantId) return reply.status(403).send({ error: 'Forbidden' })
      amountPaise = Number(invoice.total_paise)
      receiptRef  = `inv_${invoiceId}`
    } else {
      // Current month cost
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      const { rows } = await app.pg.query(`
        SELECT
          COALESCE(
            ROUND(SUM(c.cpu_seconds) * 0.14)::BIGINT
            + ROUND(SUM(c.memory_byte_secs) / (1024.0 * 1024 * 1024) * 0.007)::BIGINT,
            0
          ) AS total_paise
        FROM cpu_seconds_log c
        JOIN apps a ON a.name = c.app_name
        WHERE c.window_start >= $1
          AND c.window_start <  $2
          AND a.owner = $3
      `, [monthStart.toISOString(), monthEnd.toISOString(), tenantId])
      amountPaise = Number(rows[0]?.total_paise ?? 0)
    }

    // If Razorpay is not configured, return a stub so the dashboard doesn't crash
    if (!keyId || !keySecret) {
      return {
        stub:        true,
        url:         `https://checkout.razorpay.com/stub?tenant=${encodeURIComponent(tenantId)}`,
        order_id:    null,
        key_id:      null,
        amount:      amountPaise,
        currency:    'INR',
        name:        'Tinai Cloud',
        description: 'Cloud usage payment',
      }
    }

    const orderPayload = JSON.stringify({
      amount:   amountPaise,
      currency: 'INR',
      receipt:  receiptRef,
    })

    const rzOrder = await new Promise<{ id: string; amount: number; currency: string }>((resolve, reject) => {
      const req2 = https.request(
        {
          hostname: 'api.razorpay.com',
          path:     '/v1/orders',
          method:   'POST',
          headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(orderPayload),
            'Authorization':  'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
          },
        },
        (res) => {
          let data = ''
          res.on('data', chunk => { data += chunk })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data)
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`Razorpay error ${res.statusCode}: ${data}`))
              } else {
                resolve(parsed)
              }
            } catch (e) {
              reject(e)
            }
          })
        }
      )
      req2.on('error', reject)
      req2.write(orderPayload)
      req2.end()
    })

    // Persist order id on the invoice if one was supplied
    if (invoiceId) {
      await app.pg.query(
        `UPDATE invoices SET razorpay_order_id = $1, payment_status = 'pending' WHERE id = $2`,
        [rzOrder.id, invoiceId]
      )
    }

    return {
      stub:        false,
      url:         `https://checkout.razorpay.com/v1/checkout.js`,
      order_id:    rzOrder.id,
      key_id:      keyId,
      amount:      rzOrder.amount,
      currency:    rzOrder.currency,
      name:        'Tinai Cloud',
      description: invoiceId ? `Invoice ${invoiceId}` : 'Cloud usage payment',
    }
  })
}
