/*
 * Settings routes — profile, password, notifications, API keys, account
 *
 * Requires migrations:
 *   002_feature_tables.sql  — users table, api_keys table
 *   005_settings.sql        — api_keys table (if separate)
 *   016_user_profile.sql    — display_name, mobile, notification_prefs columns
 */

import { FastifyInstance } from 'fastify'
import { createHash, randomBytes, pbkdf2Sync } from 'crypto'

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function hashPassword(password: string, salt: string): string {
  return pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex')
}

export async function settingsRoutes(app: FastifyInstance) {

  // -------------------------------------------------------------------------
  // Profile — GET
  // -------------------------------------------------------------------------
  app.get('/settings/profile', async (req) => {
    const userId = (req as any).userId
    const { rows } = await app.pg.query(
      `SELECT display_name, email, mobile FROM users WHERE id = $1`,
      [userId],
    )
    if (!rows.length) return { display_name: '', email: '', mobile: '' }
    return rows[0]
  })

  // -------------------------------------------------------------------------
  // Profile — PUT
  // -------------------------------------------------------------------------
  app.put<{ Body: { display_name?: string; mobile?: string } }>(
    '/settings/profile',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            display_name: { type: 'string', maxLength: 120 },
            mobile:       { type: 'string', maxLength: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const userId = (req as any).userId
      const { display_name, mobile } = req.body

      await app.pg.query(
        `UPDATE users
            SET display_name = COALESCE($2, display_name),
                mobile       = COALESCE($3, mobile)
          WHERE id = $1`,
        [userId, display_name ?? null, mobile ?? null],
      )
      return reply.status(200).send({ ok: true })
    },
  )

  // -------------------------------------------------------------------------
  // Password — PUT
  // -------------------------------------------------------------------------
  app.put<{ Body: { current_password: string; new_password: string } }>(
    '/settings/password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['current_password', 'new_password'],
          properties: {
            current_password: { type: 'string', minLength: 1 },
            new_password:     { type: 'string', minLength: 8 },
          },
        },
      },
    },
    async (req, reply) => {
      const userId = (req as any).userId
      const { current_password, new_password } = req.body

      const { rows } = await app.pg.query(
        `SELECT password_hash FROM users WHERE id = $1`,
        [userId],
      )
      if (!rows.length) return reply.status(404).send({ error: 'user not found' })

      // Verify current password — hash format is "pbkdf2:salt:hash"
      const parts = (rows[0].password_hash as string).split(':')
      const [prefix, salt, storedHash] = parts.length === 3 ? parts : ['legacy', parts[0], parts[1]]
      if (!salt || !storedHash) return reply.status(400).send({ error: 'cannot change password for this account type' })
      const check = hashPassword(current_password, salt)
      if (check !== storedHash) return reply.status(401).send({ error: 'current password is incorrect' })

      // Hash and store new password
      const newSalt = randomBytes(16).toString('hex')
      const newHash = hashPassword(new_password, newSalt)
      await app.pg.query(
        `UPDATE users SET password_hash = $2 WHERE id = $1`,
        [userId, `pbkdf2:${newSalt}:${newHash}`],
      )
      return reply.status(200).send({ ok: true })
    },
  )

  // -------------------------------------------------------------------------
  // Notifications — GET
  // -------------------------------------------------------------------------
  app.get('/settings/notifications', async (req) => {
    const userId = (req as any).userId
    const { rows } = await app.pg.query(
      `SELECT notification_prefs FROM users WHERE id = $1`,
      [userId],
    )
    if (!rows.length) return { deploy_success: true, deploy_failure: true, billing_threshold: '1000', compliance_deadline: true }
    return rows[0].notification_prefs
  })

  // -------------------------------------------------------------------------
  // Notifications — PUT
  // -------------------------------------------------------------------------
  app.put<{ Body: Record<string, unknown> }>(
    '/settings/notifications',
    async (req, reply) => {
      const userId = (req as any).userId
      await app.pg.query(
        `UPDATE users SET notification_prefs = $2 WHERE id = $1`,
        [userId, JSON.stringify(req.body)],
      )
      return reply.status(200).send({ ok: true })
    },
  )

  // -------------------------------------------------------------------------
  // API Keys — list
  // -------------------------------------------------------------------------
  app.get('/settings/api-keys', async (req) => {
    const userId = (req as any).userId
    const { rows } = await app.pg.query(
      `SELECT id, name, key_prefix, last_used, created_at
         FROM api_keys
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    )
    return rows
  })

  // -------------------------------------------------------------------------
  // API Keys — create (returns raw key once)
  // -------------------------------------------------------------------------
  app.post<{ Body: { name: string } }>(
    '/settings/api-keys',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 63 },
          },
        },
      },
    },
    async (req, reply) => {
      const userId = (req as any).userId
      const { name } = req.body

      const rawKey   = `tni_${randomBytes(32).toString('hex')}`
      const keyHash  = hashKey(rawKey)
      const keyPrefix = rawKey.slice(0, 8)

      const { rows } = await app.pg.query(
        `INSERT INTO api_keys (user_id, name, key_hash, key_prefix)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, key_prefix, created_at`,
        [userId, name, keyHash, keyPrefix],
      )
      return reply.status(201).send({ ...rows[0], key: rawKey })
    },
  )

  // -------------------------------------------------------------------------
  // API Keys — revoke
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/settings/api-keys/:id', async (req, reply) => {
    const userId = (req as any).userId
    const result = await app.pg.query(
      `DELETE FROM api_keys WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId],
    )
    if (!result.rowCount) return reply.status(404).send({ error: 'API key not found' })
    return reply.status(204).send()
  })

  // -------------------------------------------------------------------------
  // Account — delete
  // -------------------------------------------------------------------------
  app.delete('/settings/account', async (req, reply) => {
    const userId = (req as any).userId

    // Cascade: api_keys, refresh_tokens, workloads owned by this user
    await app.pg.query(`DELETE FROM api_keys      WHERE user_id = $1`, [userId])
    await app.pg.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId])
    await app.pg.query(`DELETE FROM users          WHERE id = $1`,      [userId])

    return reply.status(200).send({ ok: true })
  })
}
