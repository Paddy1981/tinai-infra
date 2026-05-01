import { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/requireAdmin'

// ---------------------------------------------------------------------------
// Body shapes
// ---------------------------------------------------------------------------

interface UpdateRoleBody {
  role: 'tenant' | 'admin'
}

interface AssignPlanBody {
  plan_id: string
}

// ---------------------------------------------------------------------------
// Admin Routes
// ---------------------------------------------------------------------------

export async function adminRoutes(app: FastifyInstance) {

  // All routes in this plugin require admin role
  app.addHook('preHandler', requireAdmin)

  // -------------------------------------------------------------------------
  // GET /admin/users — list all users
  // -------------------------------------------------------------------------
  app.get('/admin/users', async (_req) => {
    const { rows } = await app.pg.query(
      `SELECT id, email, role, tenant_id, created_at, last_login
       FROM users
       WHERE deleted_at IS NULL
       ORDER BY created_at DESC`,
    )
    return rows
  })

  // -------------------------------------------------------------------------
  // GET /admin/users/:id — get single user
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/admin/users/:id', async (req, reply) => {
    const { id } = req.params

    const { rows: [user] } = await app.pg.query(
      `SELECT id, email, role, tenant_id, created_at, last_login, deleted_at
       FROM users
       WHERE id = $1`,
      [id],
    )

    if (!user) return reply.status(404).send({ error: 'user not found' })
    return user
  })

  // -------------------------------------------------------------------------
  // PATCH /admin/users/:id/role — update user role
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: UpdateRoleBody }>(
    '/admin/users/:id/role',
    {
      schema: {
        body: {
          type: 'object',
          required: ['role'],
          properties: {
            role: { type: 'string', enum: ['tenant', 'admin'] },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const { role } = req.body

      const { rows: [user] } = await app.pg.query(
        `UPDATE users
         SET role = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, email, role, tenant_id, created_at`,
        [role, id],
      )

      if (!user) return reply.status(404).send({ error: 'user not found' })
      return user
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /admin/users/:id — soft-delete user
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/admin/users/:id', async (req, reply) => {
    const { id } = req.params

    // Try soft-delete (deleted_at column); fall back to hard delete if column absent
    let deleted = false
    try {
      const { rows: [user] } = await app.pg.query(
        `UPDATE users
         SET deleted_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [id],
      )
      deleted = !!user
    } catch {
      // deleted_at column may not exist — fall through to hard delete
    }

    if (!deleted) {
      const { rowCount } = await app.pg.query(
        `DELETE FROM users WHERE id = $1`,
        [id],
      )
      if (!rowCount) return reply.status(404).send({ error: 'user not found' })
    }

    return reply.status(204).send()
  })

  // -------------------------------------------------------------------------
  // GET /admin/tenants — list distinct tenant_ids with user count, plan, created_at
  // -------------------------------------------------------------------------
  app.get('/admin/tenants', async (_req) => {
    const { rows } = await app.pg.query(
      `SELECT
         u.tenant_id,
         COUNT(u.id)::int                                       AS user_count,
         COALESCE(tp.plan_id, 'free')                          AS plan_id,
         MIN(u.created_at)                                      AS created_at
       FROM users u
       LEFT JOIN tenant_plans tp ON tp.tenant_id = u.tenant_id
       WHERE u.deleted_at IS NULL
       GROUP BY u.tenant_id, tp.plan_id
       ORDER BY created_at DESC`,
    )
    return rows
  })

  // -------------------------------------------------------------------------
  // GET /admin/system/config — system overview
  // -------------------------------------------------------------------------
  app.get('/admin/system/config', async (_req) => {
    const [usersRes, tenantsRes, plansRes, dbVersionRes] = await Promise.all([
      app.pg.query(`SELECT COUNT(*)::int AS total FROM users WHERE deleted_at IS NULL`),
      app.pg.query(`SELECT COUNT(DISTINCT tenant_id)::int AS total FROM users WHERE deleted_at IS NULL`),
      app.pg.query(`SELECT id, name, price_inr, limits FROM plans ORDER BY price_inr ASC`),
      app.pg.query(`SELECT version()`),
    ])

    return {
      total_users:    usersRes.rows[0].total,
      total_tenants:  tenantsRes.rows[0].total,
      plans:          plansRes.rows,
      db_version:     dbVersionRes.rows[0].version,
    }
  })

  // -------------------------------------------------------------------------
  // POST /admin/tenants/:tenant_id/plan — force-assign plan to tenant
  // -------------------------------------------------------------------------
  app.post<{ Params: { tenant_id: string }; Body: AssignPlanBody }>(
    '/admin/tenants/:tenant_id/plan',
    {
      schema: {
        body: {
          type: 'object',
          required: ['plan_id'],
          properties: {
            plan_id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { tenant_id } = req.params
      const { plan_id } = req.body

      // Verify plan exists
      const { rows: [plan] } = await app.pg.query(
        `SELECT id FROM plans WHERE id = $1`,
        [plan_id],
      )
      if (!plan) return reply.status(404).send({ error: `plan "${plan_id}" not found` })

      // Upsert tenant plan (bypasses payment — admin override)
      const { rows: [assigned] } = await app.pg.query(
        `INSERT INTO tenant_plans (tenant_id, plan_id, started_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (tenant_id) DO UPDATE
           SET plan_id    = EXCLUDED.plan_id,
               started_at = NOW(),
               expires_at = NULL
         RETURNING tenant_id, plan_id, started_at`,
        [tenant_id, plan_id],
      )

      return reply.status(200).send(assigned)
    },
  )
}
